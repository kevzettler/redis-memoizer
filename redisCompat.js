// ioredis/node_redis compat

module.exports.exec = function exec(client, key, ...args) {
  const fn = client[key + 'Async'] || client[key];
  return fn.apply(client, args);
};

module.exports.isReady = function isReady(client) {
  // Bail if not connected; don't wait for reconnect, that's probably slower than just computing.
  const connectedNodeRedis = Boolean(client.connected);
  const connectedIORedis = client.status === 'ready';
  return Boolean(connectedNodeRedis || connectedIORedis);
};
