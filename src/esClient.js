import { Client } from '@elastic/elasticsearch';

const node = process.env.ES_NODE || 'http://localhost:9200';
const username = process.env.ES_USERNAME;
const password = process.env.ES_PASSWORD;

const config = {
  node,
  // Fail fast when ES is unreachable instead of hanging on long retries.
  maxRetries: 1,
  requestTimeout: 8000,
  pingTimeout: 3000,
};

if (username && password) {
  config.auth = { username, password };
}

// Allow self-signed certs for local https clusters when configured.
if (node.startsWith('https') && process.env.ES_TLS_REJECT_UNAUTHORIZED === 'false') {
  config.tls = { rejectUnauthorized: false };
}

export const es = new Client(config);
