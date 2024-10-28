#!/usr/bin/env node

import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import open from 'open';
import fetch from 'node-fetch';
import enquirer from 'enquirer';
import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { NtfrTunnel } from '@novu/ntfr-client';
import ws from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { Novu } from '@novu/node';
import net from 'net';

const { Select, prompt } = enquirer;

const REPO_URL = "https://github.com/iampearceman/novu-nextjs-init.git";
const REPO_NAME = path.basename(REPO_URL, '.git');
const TUNNEL_URL = 'https://novu.sh/api/tunnels';
const DEFAULT_PORT = 4000;

// Simple config implementation
const config = {
    values: {},
    getValue(key) {
        return this.values[key];
    },
    setValue(key, value) {
        this.values[key] = value;
    }
};

let tunnelClient = null;

function runCommand(command) {
    try {
        execSync(`${command}`, { stdio: 'inherit' });
        return true;
    } catch (error) {
        console.error(chalk.red(`Failed to execute ${command}`), error);
        return false;
    }
}

// Add this function to find an available port
function findAvailablePort(startPort) {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(startPort, () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                findAvailablePort(startPort + 1).then(resolve, reject);
            } else {
                reject(err);
            }
        });
    });
}


const askNovuAccount = async () => {
    const prompt = new Select({
        name: 'novuAccount',
        message: 'Do you have a Novu account?',
        choices: ['Yes', 'No'],
    });
    return prompt.run();
};

// Add a new function to ask for the user's region
const askUserRegion = async () => {
    const prompt = new Select({
        name: 'region',
        message: 'Are you from the EU or US?',
        choices: ['EU', 'US'],
    });
    return prompt.run();
};

// Modify the openBrowserForAccount function
const openBrowserForAccount = async (answer, region) => {
    const baseUrl = region === 'EU' ? 'https://eu.dashboard.novu.co' : 'https://dashboard.novu.co';
    const url = answer === 'Yes'
        ? `${baseUrl}/api-keys?utm_source=cli&utm_medium=onboarding&utm_campaign=cli_onboarding`
        : `${baseUrl}/auth/signup?utm_source=cli&utm_medium=onboarding&utm_campaign=cli_onboarding`;
    console.log(chalk.cyan(`Opening Novu dashboard in your browser...`));
    await open(url);
};

const askApiKey = async () => {
    console.log(chalk.yellow("\nPlease provide your Novu API Key:"));
    console.log(chalk.gray("(You can find this in the Novu dashboard under 'API Keys')"));
    const { apiKey } = await prompt({
        type: 'password',
        name: 'apiKey',
        message: 'Novu API Key:',
    });
    return apiKey;
};

// Modify the validateApiKey function
const validateApiKey = async (apiKey, region) => {
    const spinner = ora('Validating API Key...').start();
    const apiUrl = region === 'EU' ? 'https://eu.api.novu.co' : 'https://api.novu.co';
    const options = {
        method: 'GET',
        headers: { Authorization: `ApiKey ${apiKey}` },
    };
    try {
        const response = await fetch(`${apiUrl}/v1/environments/me`, options);
        const data = await response.json();
        if (response.ok) {
            spinner.succeed(chalk.green('API Key is valid!'));
            console.log(chalk.cyan(`Identifier: ${data.data.identifier}`));
            console.log(chalk.cyan(`Environment Name: ${data.data.name}`));
            return { isValid: true, apiKey, identifier: data.data.identifier };
        } else {
            spinner.fail(chalk.red(`Error: ${data.message}`));
            return { isValid: false };
        }
    } catch (error) {
        spinner.fail(chalk.red('Validation failed'));
        console.error(error);
        return { isValid: false };
    }
};

const runNovuOnboarding = async () => {
    try {
        console.log(chalk.bold.blue('\n🚀 Starting Novu onboarding process...'));
        const region = await askUserRegion();
        const accountAnswer = await askNovuAccount();
        await openBrowserForAccount(accountAnswer, region);
        let isValid = false;
        let result;
        while (!isValid) {
            const apiKey = await askApiKey();
            result = await validateApiKey(apiKey, region);
            isValid = result.isValid;
            if (!isValid) {
                console.log(chalk.red('Invalid API Key. Please try again.'));
            }
        }
        console.log(chalk.green.bold('✅ Novu configuration completed successfully!'));
        return { ...result, region };
    } catch (error) {
        console.error(chalk.red('Error during Novu onboarding:'), error);
        return null;
    }
};

async function createEnvFile(variables, directory) {
    const envContent = Object.entries(variables)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');

    fs.writeFileSync(path.join(directory, '.env.local'), envContent);
    console.log(chalk.green('✅ .env.local file created successfully.'));
}

async function createTunnel(localOrigin, endpointRoute) {
    const devSpinner = ora('Creating a development local tunnel').start();
    const originUrl = new URL(localOrigin);
    const configTunnelUrl = config.getValue(`tunnelUrl-${parseInt(originUrl.port, 10)}`);
    const storeUrl = configTunnelUrl ? new URL(configTunnelUrl) : null;

    let tunnelOrigin;

    if (storeUrl) {
        try {
            await connectToTunnel(storeUrl, originUrl);

            if (tunnelClient.isConnected) {
                tunnelOrigin = storeUrl.origin;
            }
        } catch (error) {
            tunnelOrigin = await connectToNewTunnel(originUrl);
        }
    } else {
        tunnelOrigin = await connectToNewTunnel(originUrl);
    }

    devSpinner.succeed(`🛣️  Tunnel    → ${tunnelOrigin}${endpointRoute}`);
    return tunnelOrigin;
}

async function fetchNewTunnel(originUrl) {
    const response = await fetch(TUNNEL_URL, {
        method: 'POST',
        headers: {
            accept: 'application/json',
            'Content-Type': 'application/json',
            authorization: `Bearer 12345`,
        },
    });

    const { url } = await response.json();
    config.setValue(`tunnelUrl-${parseInt(originUrl.port, 10)}`, url);

    return new URL(url);
}

async function connectToTunnel(parsedUrl, parsedOrigin) {
    tunnelClient = new NtfrTunnel(
        parsedUrl.host,
        parsedOrigin.host,
        false,
        {
            WebSocket: ws,
            connectionTimeout: 2000,
            maxRetries: Infinity,
        },
        { verbose: false }
    );

    await tunnelClient.connect();
}

async function connectToNewTunnel(originUrl) {
    const parsedUrl = await fetchNewTunnel(originUrl);
    await connectToTunnel(parsedUrl, originUrl);

    return parsedUrl.origin;
}

async function monitorEndpointHealth(parsedOptions, endpointRoute) {
    const fullEndpoint = `${parsedOptions.origin}${endpointRoute}`;
    let healthy = false;
    const endpointText = `Bridge Endpoint scan:\t${fullEndpoint}
  
  Ensure your application is configured and running locally.`;
    const endpointSpinner = ora(endpointText).start();

    let counter = 0;
    while (!healthy && counter < 30) {  // Added a max retry limit
        try {
            healthy = await tunnelHealthCheck(fullEndpoint);

            if (healthy) {
                endpointSpinner.succeed(`🌉 Endpoint  → ${fullEndpoint}`);
            } else {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        } catch (e) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        } finally {
            counter += 1;

            if (counter === 10) {
                endpointSpinner.text = `Bridge Endpoint scan:\t${fullEndpoint}

  Ensure your application is configured and running locally.

  Starting out? Use our starter ${chalk.bold('npx novu@latest init')}
  Running on a different route or port? Use ${chalk.bold('--route')} or ${chalk.bold('--port')}
          `;
            }
        }
    }

    if (!healthy) {
        endpointSpinner.fail(`Failed to establish a healthy connection to ${fullEndpoint}`);
        return false;
    }

    return true;
}

async function tunnelHealthCheck(configTunnelUrl) {
    try {
        const res = await fetch(`${configTunnelUrl}?action=health-check`, {
            method: 'GET',
            headers: {
                accept: 'application/json',
                'Content-Type': 'application/json',
                'User-Agent': `novu@${process.env.npm_package_version || 'unknown'}`,
            },
        });

        const data = await res.json();
        return data.status === 'ok';
    } catch (e) {
        return false;
    }
}

async function sync(bridgeUrl, secretKey, apiUrl) {
    if (!bridgeUrl || !secretKey || !apiUrl) {
        console.error(chalk.red('Missing required parameters for sync'));
        return { success: false, error: 'Missing required parameters' };
    }

    try {
        console.log(chalk.cyan('Syncing with Novu...'));
        console.log(chalk.gray(`Bridge URL: ${bridgeUrl}`));
        console.log(chalk.gray(`API URL: ${apiUrl}`));

        const syncResult = await executeSync(apiUrl, bridgeUrl, secretKey);

        if (syncResult.status >= 400) {
            console.error(chalk.red('Sync failed with status:'), syncResult.status);
            console.error(chalk.red('Error data:'), JSON.stringify(syncResult.data, null, 2));
            return { success: false, error: syncResult.data };
        }

        console.log(chalk.green('Sync completed successfully!'));
        console.log(chalk.gray('Sync result:'), JSON.stringify(syncResult.data, null, 2));
        return { success: true, data: syncResult.data };
    } catch (error) {
        console.error(chalk.red('Sync failed:'), error.message);
        if (error.response) {
            console.error(chalk.red('Error status:'), error.response.status);
            console.error(chalk.red('Error data:'), JSON.stringify(error.response.data, null, 2));
        }
        return { success: false, error: error.message };
    }
}

async function executeSync(apiUrl, bridgeUrl, secretKey) {
    const url = `${apiUrl}/v1/bridge/sync?source=cli`;

    return await axios.post(
        url,
        {
            bridgeUrl,
        },
        {
            headers: {
                'Content-Type': 'application/json',
                Authorization: `ApiKey ${secretKey}`,
            },
        }
    );
}

async function setupProject(novuConfig) {
    console.log(chalk.bold.blue('\n🚀 Setting up your Next.js project...'));

    const projectDir = path.join(process.cwd(), REPO_NAME);

    if (fs.existsSync(projectDir)) {
        console.log(chalk.yellow(`The directory ${REPO_NAME} already exists.`));
        const { overwrite } = await prompt({
            type: 'confirm',
            name: 'overwrite',
            message: 'Do you want to overwrite it?',
            default: false
        });

        if (overwrite) {
            fs.rmSync(projectDir, { recursive: true, force: true });
        } else {
            console.log(chalk.yellow('Using existing directory.'));
            process.chdir(projectDir);
            return;
        }
    }

    const spinner = ora(`Cloning repository from ${REPO_URL}`).start();
    if (!runCommand(`git clone ${REPO_URL}`)) {
        spinner.fail(chalk.red('Failed to clone repository'));
        process.exit(1);
    }
    spinner.succeed(chalk.green('Repository cloned successfully'));

    spinner.text = 'Changing to repository directory';
    spinner.start();
    process.chdir(REPO_NAME);
    spinner.succeed(chalk.green('Changed to repository directory'));

    spinner.text = 'Creating .env.local file with Novu configuration';
    spinner.start();
    const subscriberId = uuidv4();
    const envVariables = {
        NEXT_PUBLIC_NOVU_APPLICATION_IDENTIFIER: novuConfig.identifier,
        NOVU_SECRET_KEY: novuConfig.apiKey,
        NEXT_PUBLIC_NOVU_SUBSCRIBER_ID: subscriberId
    };
    await createEnvFile(envVariables, process.cwd());
    spinner.succeed(chalk.green('.env.local file created with Novu configuration and subscriber ID'));

    spinner.text = 'Installing dependencies';
    spinner.start();
    if (!runCommand('npm install')) {
        spinner.fail(chalk.red('Failed to install dependencies'));
        process.exit(1);
    }
    spinner.succeed(chalk.green('Dependencies installed successfully'));
    return subscriberId;
}

async function startDevServer(port) {
    return new Promise((resolve, reject) => {
        console.log(chalk.yellow(`\nStarting the development server on port ${port}...`));
        const child = spawn('npm', ['run', 'dev', '--', '-p', port.toString()], { stdio: 'pipe' });

        child.stdout.on('data', (data) => {
            const output = data.toString();
            console.log(output);
            if (output.includes('Ready in')) {
                resolve(true);
            }
        });

        child.stderr.on('data', (data) => {
            console.error(chalk.red(data.toString()));
        });

        child.on('error', (error) => {
            console.error(chalk.red('Failed to start the development server'), error);
            reject(error);
        });

        child.on('close', (code) => {
            if (code !== 0) {
                console.error(chalk.red(`Development server process exited with code ${code}`));
                reject(new Error(`Server exited with code ${code}`));
            }
        });

        // Timeout after 60 seconds
        setTimeout(() => {
            reject(new Error('Timeout: Server did not start within 60 seconds'));
        }, 60000);
    });
}


async function waitForServerReady(port) {
    console.log(chalk.gray(`Waiting for the server to be ready on port ${port}...`));
    for (let i = 0; i < 30; i++) {
        try {
            const response = await axios.get(`http://localhost:${port}`);
            if (response.status === 200) {
                console.log(chalk.green('Server is ready!'));
                return true;
            }
        } catch (error) {
            // Ignore errors and continue trying
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    console.error(chalk.red('Server did not become ready within the expected time.'));
    return false;
}

async function reloadApplication(url) {
    console.log(chalk.cyan('Reloading the application...'));
    await open(url);
    console.log(chalk.green('Application reloaded!'));
}

async function main() {
    console.log(chalk.bold.blue('\n🎉 Welcome to the Novu + Next.js Starter Kit! 🎉\n'));

    const novuConfig = await runNovuOnboarding();
    if (!novuConfig) {
        console.log(chalk.red('Novu onboarding failed. Exiting...'));
        return;
    }

    const subscriberId = await setupProject(novuConfig);

    // Find an available port starting from DEFAULT_PORT
    const port = await findAvailablePort(DEFAULT_PORT);
    console.log(chalk.cyan(`Using port: ${port}`));

    try {
        await startDevServer(port);
        const serverReady = await waitForServerReady(port);
        if (!serverReady) {
            console.error(chalk.red('Failed to confirm server is ready. Continuing with caution.'));
        }
    } catch (error) {
        console.error(chalk.red('Failed to start the development server:'), error);
        process.exit(1);
    }

    // Create Tunnel
    const tunnelOrigin = await createTunnel(`http://localhost:${port}`, '/api/novu');
    if (tunnelOrigin) {
        console.log(chalk.yellow('\nYou can also access your app via the public URL above.'));
        console.log(chalk.cyan('Tunnel URL:'), tunnelOrigin);
        console.log(chalk.cyan('Novu API Key (first 10 characters):'), novuConfig.apiKey.substring(0, 10) + '...');

        // Monitor endpoint health
        const endpointHealthy = await monitorEndpointHealth({ origin: `http://localhost:${port}` }, '/api/novu');

        if (endpointHealthy) {
            const apiUrl = novuConfig.region === 'EU' ? 'https://eu.api.novu.co' : 'https://api.novu.co';
            const syncResult = await sync(`${tunnelOrigin}/api/novu`, novuConfig.apiKey, apiUrl);
            if (syncResult.success) {
                console.log(chalk.green('Sync completed successfully!'));
                // Trigger Novu notification after successful sync
                try {
                    const novu = new Novu(novuConfig.apiKey, {
                        backendUrl: apiUrl
                    });
                    const result = await novu.trigger('Inbox Demo', {
                        to: {
                            subscriberId: subscriberId,
                        },
                        payload: {}
                    });

                    console.log(chalk.green('Novu notification triggered successfully!'));
                    console.log(chalk.cyan('Novu API Response:'));
                    console.log(chalk.cyan('Status:'), result.status);
                    console.log(chalk.cyan('Data:'), JSON.stringify(result.data, null, 2));

                    if (result.status === 201) {
                        console.log(chalk.green('✅ Novu notification triggered successfully!'));

                        // Schedule the application reload after 5 seconds
                        console.log(chalk.cyan('\nScheduling application reload in 5 seconds...'));
                        setTimeout(async () => {
                            await reloadApplication(`http://localhost:${port}`);
                        }, 5000);
                    } else {
                        console.log(chalk.yellow('⚠️ Novu notification triggered, but with an unexpected status code.'));
                        console.log(chalk.yellow('Please check the Novu dashboard for more details.'));
                    }
                } catch (error) {
                    console.error(chalk.red('❌ Failed to trigger Novu notification:'));
                    if (error.response) {
                        console.error(chalk.red('Status:'), error.response.status);
                        console.error(chalk.red('Error Data:'), JSON.stringify(error.response.data, null, 2));
                    } else if (error.request) {
                        console.error(chalk.red('No response received from Novu API'));
                        console.error(chalk.red('Request:'), error.request);
                    } else {
                        console.error(chalk.red('Error:'), error.message);
                    }
                    console.error(chalk.red('Stack:'), error.stack);
                }
            }
        }

        // Cleanup function for Tunnel
        process.on('SIGINT', async function () {
            console.log(chalk.yellow('\nClosing Tunnel...'));
            if (tunnelClient) {
                await tunnelClient.close();
            }
            process.exit();
        });
    } else {
        console.log(chalk.yellow('\nFailed to create Tunnel. You may need to manually configure your Novu settings.'));
    }

    console.log(chalk.yellow('\nHappy coding! 🎉'));
    console.log(chalk.yellow('Subscriber ID:', subscriberId));
}

main().catch((error) => {
    console.error(chalk.red('An unexpected error occurred:'), error);
    process.exit(1);
});
