const { onRequest } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { app, initialize } = require('./index');

setGlobalOptions({ region: 'us-central1', maxInstances: 10 });

let initPromise;

function ensureInitialized() {
  if (!initPromise) {
    initPromise = initialize();
  }
  return initPromise;
}

exports.api = onRequest({ cors: true }, async (req, res) => {
  await ensureInitialized();
  app(req, res);
});
