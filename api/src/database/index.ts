import knex, { Config } from 'knex';
import dotenv from 'dotenv';
import camelCase from 'camelcase';
import path from 'path';
import logger from '../logger';
import env from '../env';
import { performance } from 'perf_hooks';

import SchemaInspector from '@directus/schema';
import { getConfigFromEnv } from '../utils/get-config-from-env';

dotenv.config({ path: path.resolve(__dirname, '../../', '.env') });

const connectionConfig: Record<string, any> = getConfigFromEnv('DB_', [
	'DB_CLIENT',
	'DB_SEARCH_PATH',
	'DB_CONNECTION_STRING',
]);

const knexConfig: Config = {
	client: env.DB_CLIENT,
	searchPath: env.DB_SEARCH_PATH,
	connection: env.DB_CONNECTION_STRING || connectionConfig,
	log: {
		warn: (msg) => logger.warn(msg),
		error: (msg) => logger.error(msg),
		deprecate: (msg) => logger.info(msg),
		debug: (msg) => logger.debug(msg),
	},
};

if (env.DB_CLIENT === 'sqlite3') {
	knexConfig.useNullAsDefault = true;
}

const database = knex(knexConfig);

const times: Record<string, number> = {};

database
	.on('query', (queryInfo) => {
		times[queryInfo.__knexUid] = performance.now();
	})
	.on('query-response', (response, queryInfo) => {
		const delta = performance.now() - times[queryInfo.__knexUid];
		logger.trace(`[${delta.toFixed(3)}ms] ${queryInfo.sql} [${queryInfo.bindings.join(', ')}]`);
	});

export async function validateDBConnection() {
	try {
		await database.raw('select 1+1 as result');
	} catch (error) {
		logger.fatal(`Can't connect to the database.`);
		logger.fatal(error);
		process.exit(1);
	}
}

export const schemaInspector = SchemaInspector(database);

export async function isInstalled() {
	// The existence of a directus_collections table alone isn't a "proper" check to see if everything
	// is installed correctly of course, but it's safe enough to assume that this collection only
	// exists when using the installer CLI.
	return await schemaInspector.hasTable('directus_collections');
}

export default database;
