const { app, ensureInitialized } = require('../index');

module.exports = async (req, res) => {
  try {
    await ensureInitialized();
  } catch (error) {
    console.error('MongoDB init failed:', error.message || error);
  }
  return app(req, res);
};
