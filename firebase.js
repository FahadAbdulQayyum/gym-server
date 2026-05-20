const { onRequest } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const { app, ensureInitialized } = require('./index');

setGlobalOptions({ region: 'us-central1', maxInstances: 10 });

exports.api = onRequest({ cors: true }, async (req, res) => {
  await ensureInitialized();
  app(req, res);
});
