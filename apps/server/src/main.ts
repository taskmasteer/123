import {runtimeDatabaseRole} from './database-role.js';
import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { migrate } from './migrate.js';
import { protectSecret } from './secrets.js';
import { createServerRuntime } from './runtime.js';
import { createHttpHandler, createNodeServer } from './http.js';

const root=resolve(process.env.SITE_FACTORY_SOURCE_ROOT??'.'),data=resolve(process.env.SITE_FACTORY_SERVER_DATA??'.local-state/server');
process.env.SITE_FACTORY_INSTALL_ROOT??=root;
const config=JSON.parse(await readFile(resolve(data,'config.json'),'utf8').then(s=>s.replace(/^\uFEFF/,'')));
const sourceRoot=resolve(config.sourceRoot??root);process.env.SITE_FACTORY_SOURCE_ROOT=sourceRoot;
const connection={host:'127.0.0.1',port:config.databasePort,user:'factory',password:await protectSecret(config.databasePassword,true),connectionTimeoutMillis:5000};
const bootstrap=new Pool({...connection,database:'postgres',max:1});
try{if(!(await bootstrap.query("select 1 from pg_database where datname=$1",[config.databaseName??'factory'])).rowCount){if(config.databaseName)throw Error('Restore database is missing');await bootstrap.query('create database factory');};}finally{await bootstrap.end();}
const migrationPool=new Pool({...connection,database:config.databaseName??'factory',max:1});
let role;try{await migrate(migrationPool,resolve(process.env.SITE_FACTORY_INSTALL_ROOT??root));role=await runtimeDatabaseRole(migrationPool);}finally{await migrationPool.end();}
const pool=new Pool({...connection,...role,database:config.databaseName??'factory',max:10});
pool.on('error',()=>console.error(new Date().toISOString(),'database.idle_connection_failed'));
if(!config.publicOrigin||!config.tlsPfx||!config.tlsPassword)throw new Error('Run server-manage.mjs address to configure HTTPS.');
const origin=config.publicOrigin;
const runtime=await createServerRuntime(pool,sourceRoot,data,origin);
const server=createNodeServer(createHttpHandler(runtime,origin,resolve(root,'apps/desktop/dist-web'),false),origin,{pfx:Buffer.from(await protectSecret(config.tlsPfx,true),'base64'),passphrase:await protectSecret(config.tlsPassword,true),minVersion:'TLSv1.2'});
server.requestTimeout=30000;server.headersTimeout=10000;
server.listen(config.tlsPort,'0.0.0.0',()=>console.log('Site Factory application API ready (TLS). No web interface is served.'));
let closing=false;async function close(){if(closing)return;closing=true;server.close();await runtime.close();await pool.end();process.exit(0);}
process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());

// The supervisor IPC pipe closes even when Windows terminates its parent.
process.on('disconnect',()=>void close());
