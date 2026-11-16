import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import express from 'express';
import { consumerStartupCommand } from '../paths/gke.js';
import { createConsumerCredentialsRouter } from '../../../workflows/googleCloud/consumerRefresh.js';

const capability = 'c'.repeat(64);
const userId = 'user-example';
const projectId = 'project-example';
const consumerId = 'consumer-example';

async function runRestart({ jobState = 'active', lock = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'awfl-firebase-restart-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const cert = join(dir, 'cert.pem');
  const key = join(dir, 'key.pem');
  const capture = join(dir, 'captured.txt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost'], {stdio:'ignore'});
  writeFileSync(join(bin,'awfl'), [
    '#!/bin/sh',
    'printf "%s\\n" "$FIREBASE_CUSTOM_TOKEN" > "$AWFL_TEST_CAPTURE"',
    'printf "%s\\n" "${FIREBASE_ID_TOKEN-unset}" >> "$AWFL_TEST_CAPTURE"',
    'printf "%s\\n" "$AWFL_PROJECT_ID" >> "$AWFL_TEST_CAPTURE"',
    'exit 0',
  ].join('\n'),{mode:0o755});
  // Failed bootstrap retries are intentional. Avoid ten seconds of sleep in tests.
  writeFileSync(join(bin,'sleep'),'#!/bin/sh\nexit 0\n',{mode:0o755});
  const app = express();
  app.use(express.json());
  const observed={requests:0, minted:0};
  app.use('/consumer-credentials', createConsumerCredentialsRouter({
    readProject: async () => ({exists:true,data:()=>({
      consumerLock:lock,
      consumerCredentialRefresh:{consumerId,hash:createHash('sha256').update(capability).digest('hex')},
    })}),
    inspectJob: async () => ({state:jobState}),
    mintFirebase: async () => {observed.minted++;return 'fresh-token-from-broker';},
  }));
  const server = https.createServer({
    key:readFileSync(key),cert:readFileSync(cert),
  }, (req,res)=>{observed.requests++;app(req,res);});
  await new Promise(resolve=>server.listen(0,'localhost',resolve));
  try {
    const origin='https://localhost:'+server.address().port;
    const start=consumerStartupCommand({refreshEnabled:false,firebaseBootstrapEnabled:true});
    const child=spawn('sh',['-c',start],{env:{
      ...process.env,
      PATH:bin+':'+process.env.PATH,
      SSL_CERT_FILE:cert,
      AWFL_TEST_CAPTURE:capture,
      AWFL_CREDENTIAL_REFRESH_CAPABILITY:capability,
      AWFL_CREDENTIAL_REFRESH_ORIGIN:origin,
      AWFL_USER_ID:userId,
      AWFL_PROJECT_ID:projectId,
      AWFL_CONSUMER_ID:consumerId,
      FIREBASE_ID_TOKEN:'old-expired-id-token',
      FIREBASE_CUSTOM_TOKEN:'old-expired-custom-token',
    }});
    let stderr='';
    child.stderr.on('data',chunk=>{stderr+=chunk.toString();});
    const code=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{child.kill();reject(new Error('startup timeout'));},10000);
      child.on('error',error=>{clearTimeout(timer);reject(error);});
      child.on('close',code=>{clearTimeout(timer);resolve(code);});
    });
    return {code,stderr,captured:existsSync(capture)?readFileSync(capture,'utf8'):null,observed};
  } finally {
    await new Promise(resolve=>server.close(resolve));
    rmSync(dir,{recursive:true,force:true});
  }
}

test('real Python HTTPS bootstrap replaces expired PodSpec credentials before awfl run', async()=>{
  const r=await runRestart();
  assert.equal(r.code,0,r.stderr);
  assert.equal(r.captured,'fresh-token-from-broker\nunset\nproject-example\n');
  assert.equal(r.observed.requests,1);
  assert.equal(r.observed.minted,1);
  assert.ok(!r.stderr.includes('fresh-token-from-broker'));
});

test('deleted Kubernetes Job refuses stale fallback and does not launch awfl', async()=>{
  const r=await runRestart({jobState:'not_found'});
  assert.equal(r.code,1);
  assert.equal(r.captured,null);
  assert.equal(r.observed.requests,5);
  assert.equal(r.observed.minted,0);
  assert.match(r.stderr,/Refusing to start with stale Firebase credentials/);
});

test('another active consumer cannot bootstrap the original job', async()=>{
  const r=await runRestart({lock:{consumerId:'another-consumer',expiresAt:Date.now()+60000}});
  assert.equal(r.code,1);
  assert.equal(r.captured,null);
  assert.equal(r.observed.minted,0);
});
