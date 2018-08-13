'use strict';
const Promise = require('bluebird');
const {exec} = require('./redisCompat');

// Variant of redis-lock intended for use with redis-memoizer. Unlike redis-lock,
// this instead takes an overall timeout, after which the lock is disregarded. This ensures
// that functions just carry on if the lock is held for too long.
async function acquireLock(client, lockName, timeoutStamp, retryDelay, emitter) {
  try {
    const timeoutLeft = timeoutStamp - Date.now();
    if (timeoutLeft <= 0) {
      if(emitter) emitter.emit('lock_timeout', lockName.split('.')[1]);
      return;
    }
    // Set an exclusive key. PX is timeout in ms, NX is don't set if already set.
    const result = await exec(client, 'set', lockName, '1', 'PX', timeoutLeft, 'NX');
    if (result.toString() !== 'OK') throw new Error('Lock not acquired.');
  } catch (e) {
    // Try again if we errored for some reason: internal error or just lock already held.
    await Promise.delay(retryDelay);
    return acquireLock(client, lockName, timeoutStamp, retryDelay);
  }
}

module.exports = function(client, options) {
  const retryDelay = options.lock_retry_delay || 50;

  return async function lock(lockName, timeout) {
    const startTime = Date.now();
    if (!lockName) {
      throw new Error("You must specify a lock key.");
    }
    lockName = `lock.${lockName}`;
    const timeoutStamp = Date.now() + timeout + 1;
    await acquireLock(client, lockName, timeoutStamp, retryDelay, options.emitter);

    return function unlock() {
      // Now that the task is done, if the lock would still exist, kill it
      options.emitter.emit(`unlock.${lockName}`);
      if (timeoutStamp > Date.now()) return exec(client, 'del', lockName);
      if(options.emitter) options.emitter.emit('unlock', lockName.split('.')[1], Date.now() - startTime);
      return Promise.resolve();
    };
  };
};
