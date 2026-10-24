// SPDX-License-Identifier: AGPL-3.0-or-later

import {createAPIApp} from '@app/api/App';
import {OPERATOR_SOCKET_PATH} from '@app/api/admin/operator/OperatorRequests';
import {listenOperatorSocket} from '@app/api/admin/operator/OperatorSocket';
import {buildAPIServerOptions, initializeConfig} from '@app/api/Config';
import {sizeProcessForHost} from '@app/api/infrastructure/HostResources';
import {initializeLogger} from '@app/api/Logger';
import {Config} from '@app/Config';
import {Logger} from '@app/Logger';
import {createServer, setupGracefulShutdown} from '@fluxer/hono/src/Server';

async function closeHttpServer(server: {close: (callback: (error?: Error) => void) => void}): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error !== undefined) {
				reject(error);
				return;
			}
			resolve();
		});
	});
}

async function main(): Promise<void> {
	initializeConfig(Config);
	initializeLogger(Logger);
	sizeProcessForHost(Logger);
	const {app, initialize, shutdown} = await createAPIApp({
		config: Config,
		logger: Logger,
	});
	await initialize();
	process.on('uncaughtException', (error) => {
		Logger.error({error}, 'Uncaught exception');
	});
	process.on('unhandledRejection', (reason) => {
		Logger.error({reason}, 'Unhandled rejection (suppressed)');
	});
	const server = createServer(app, buildAPIServerOptions(Config));
	Logger.info({port: Config.port}, `Starting Fluxer API on port ${Config.port}`);
	const operatorServer = await listenOperatorSocket(app, OPERATOR_SOCKET_PATH, Logger);
	setupGracefulShutdown(
		async () => {
			await closeHttpServer(server);
			if (operatorServer) {
				await closeHttpServer(operatorServer);
			}
			await shutdown();
		},
		{logger: Logger, timeoutMs: 30000},
	);
}

main().catch((err) => {
	Logger.fatal({error: err}, 'Failed to start Fluxer API');
	process.exit(1);
});
