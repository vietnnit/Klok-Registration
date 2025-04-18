import fs from "fs";
import axios from "axios";
import { Wallet } from "ethers";
import crypto from "crypto";
import chalk from "chalk";
import pLimit from "p-limit";
import { HttpsProxyAgent } from 'https-proxy-agent';
import config from "./config.js";
import displayBanner from "./banner.js";

function getTimeStamp() {
  const now = new Date();
  const time = now.toLocaleTimeString("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour12: false,
  });
  const date = now.toLocaleDateString("en-GB", { timeZone: "Asia/Ho_Chi_Minh" });
  return `[${time} ${date}]`;
}

function logInfo(message, idx) {
  const prefix = idx !== undefined ? `${getTimeStamp()} [${idx}] [INFO]` : `${getTimeStamp()} [INFO]`;
  console.log(chalk.blue(`${prefix} ${message}`));
}

function logSuccess(message, idx) {
  const prefix = idx !== undefined ? `${getTimeStamp()} [${idx}] [SUCCESS]` : `${getTimeStamp()} [SUCCESS]`;
  console.log(chalk.green(`${prefix} ${message}`));
}

function logError(message, idx) {
  const prefix = idx !== undefined ? `${getTimeStamp()} [${idx}] [ERROR]` : `${getTimeStamp()} [ERROR]`;
  console.error(chalk.red(`${prefix} ${message}`));
}

function generateNonce() {
  return crypto.randomBytes(48).toString("hex");
}

async function signMessage(wallet) {
  const nonce = generateNonce();
  const timestamp = new Date().toISOString();
  const message = `klokapp.ai wants you to sign in with your Ethereum account:
${wallet.address}


URI: https://klokapp.ai/
Version: 1
Chain ID: 1
Nonce: ${nonce}
Issued At: ${timestamp}`;

  return {
    signature: await wallet.signMessage(message),
    message: message,
    nonce: nonce,
    timestamp: timestamp,
  };
}

async function authenticate(wallet, proxyConfig, idx) {
  try {
    const signResult = await signMessage(wallet);
    const payload = {
      signedMessage: signResult.signature,
      message: signResult.message,
      referral_code: config.REFERRAL_CODE.referral_code,
    };

    // logInfo(
    //   `Regis for ${maskAddress(wallet.address)} using ${
    //     proxyConfig ? `proxy ${proxyConfig.host}:${proxyConfig.port}` : "default connection"
    //   }...`,
    //   idx
    // );

    const options = {
      headers: config.DEFAULT_HEADERS,
      timeout: 60000,
    };

    if (proxyConfig) {
      const proxyUrl = `http://${proxyConfig.auth.username}:${proxyConfig.auth.password}@${proxyConfig.host}:${proxyConfig.port}`;
      const agent = new HttpsProxyAgent(proxyUrl);
      options.httpAgent = agent;
      options.httpsAgent = agent;
      options.proxy = false; 
    }

    const response = await axios.post(`${config.BASE_URL}/verify`, payload, options);
    const { session_token } = response.data;
    logSuccess(`Register successfully for ${maskAddress(wallet.address)}`, idx);
    return session_token;
  } catch (error) {
    logError(`Failed for ${maskAddress(wallet.address)}: ${error.message}`, idx);
    if (error.response) {
      logError(
        `Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`,
        idx
      );
    }
    return null;
  }
}

function parseProxy(proxyString) {
  try {
    const urlObj = new URL(proxyString);
    return {
      protocol: urlObj.protocol.slice(0, -1),
      host: urlObj.hostname,
      port: parseInt(urlObj.port),
      auth: {
        username: urlObj.username,
        password: urlObj.password,
      },
    };
  } catch (error) {
    logError(`Invalid proxy format: ${proxyString}`);
    return null;
  }
}

async function getCurrentIP(proxyConfig) {
  try {
    const options = { timeout: 10000 };
    if (proxyConfig) {
      const agent = new HttpsProxyAgent(`http://${proxyConfig.auth.username}:${proxyConfig.auth.password}@${proxyConfig.host}:${proxyConfig.port}`);
      options.httpAgent = agent;
      options.httpsAgent = agent;
      options.proxy = false;
    }
    const response = await axios.get("https://api.ipify.org?format=json", options);
    return response.data.ip;
  } catch (error) {
    logError(
      `Failed to get current IP${proxyConfig ? ` using proxy ${proxyConfig.host}:${proxyConfig.port}` : ""} - ${error.message}`
    );
    return "Unknown";
  }
}

function maskAddress(address) {
  if (address.length <= 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

async function main() {
  displayBanner();
  const privFile = "priv.txt";
  let privateKeys;
  try {
    privateKeys = fs
      .readFileSync(privFile, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  } catch (error) {
    logError(`Failed to read ${privFile}: ${error.message}`);
    process.exit(1);
  }

  const proxiesFile = "proxies.txt";
  let proxiesList = [];
  if (fs.existsSync(proxiesFile)) {
    try {
      proxiesList = fs
        .readFileSync(proxiesFile, "utf-8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
    } catch (error) {
      logError(`Failed to read ${proxiesFile}: ${error.message}`);
    }
  } else {
    logInfo("No proxies.txt file found, using default connection.");
  }
  const useProxy = proxiesList.length > 0;
  
  const successFile = "success.txt";
  fs.writeFileSync(successFile, ""); 
  const failFile = "fail.txt";
  fs.writeFileSync(failFile, "");

  const MAX_RETRIES = 5;
  let proxyIndex = 0;
  function getNextProxy() {
    const proxyString = proxiesList[proxyIndex % proxiesList.length];
    proxyIndex++;
    return parseProxy(proxyString);
  }

  const limit = pLimit(config.THREADS || 5);

  async function processWallet(privateKey, idx) {
    let wallet;
    try {
      wallet = new Wallet(privateKey);
    } catch (error) {
      logError(`Invalid private key: ${privateKey}`, idx);
      return;
    }
  
    let currentIP;
    let selectedProxyConfig = undefined; 
  
    if (useProxy) {
      selectedProxyConfig = getNextProxy();
      if (!selectedProxyConfig) {
        logError("Invalid initial proxy encountered, using default connection.", idx);
      }
    }
  
    currentIP = await getCurrentIP(selectedProxyConfig);
    logInfo(`Current IP for wallet ${maskAddress(wallet.address)}: ${currentIP}`, idx);
  
    let sessionToken = null;
    let attempts = 0;
  
    while (attempts < MAX_RETRIES && !sessionToken) {
      // logInfo(
      //   `Attempt ${attempts + 1} for wallet ${maskAddress(wallet.address)} using proxy ${currentIP}`,
      //   idx
      // );

      sessionToken = await authenticate(wallet, selectedProxyConfig, idx);
  
      if (!sessionToken) {
        logError(`Retrying wallet ${maskAddress(wallet.address)}...`, idx);
      }
  
      attempts++;
    }
  
    if (sessionToken) {
      const line = `${wallet.address}:${privateKey}:${sessionToken}\n`;
      fs.appendFileSync(successFile, line);
    } else {
      logError(`Failed to obtain session token for ${maskAddress(wallet.address)} after ${MAX_RETRIES} attempts.`, idx);
      const failLine = `${wallet.address}:${privateKey}\n`;
      fs.appendFileSync(failFile, failLine);
    }
  }  

  const tasks = privateKeys.map((key, i) => limit(() => processWallet(key, i + 1)));
  await Promise.all(tasks);
}

main();
