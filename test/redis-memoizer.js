const crypto = require('crypto');
const should = require('should');
const Promise = require('bluebird');

const memoizePkg = require('../');
const pkgJSON = JSON.stringify(require('../package.json'));
const {exec} = require('../redisCompat');
const PORT = parseInt(process.env.PORT) || 6379;

const hash = (string) => crypto.createHmac('sha1', 'memo').update(string).digest('hex');
const key_namespace = Date.now();

async function delKeys(client, keyPattern) {
  const keys = await exec(client, 'keys', keyPattern);
  return await Promise.map(keys, (key) => exec(client, 'del', key.toString()));
}

function makeDefaultOptions() {
  return {
    memoize_key_namespace: key_namespace,
    on_error: (err) => { throw err; },
  };
}

describe('redis-memoizer', () => {

  let client;
  const {REDIS_TYP} = process.env;
  if (REDIS_TYP === 'ioredis') {
    const Redis = REDIS_TYP === 'fakeredis' ? require('fakeredis') : require('redis');
    Promise.promisifyAll(Redis.RedisClient.prototype);
    Promise.promisifyAll(Redis.Multi.prototype);
    client = Redis.createClient(PORT, 'localhost', {return_buffers: true});
    if (REDIS_TYP === 'fakeredis') client.options.return_buffers = true; // workaround check, it sets opts badly
  }
  let memoize = memoizePkg(client, {
    ...makeDefaultOptions(),
  });

  const originalMemoize = memoize;
  // Record the name so we can clear this out
  memoize = function(fn, options) {
    // Ensures we can't clobber our own names
    fn._name = String(Math.random()) + memoizePkg.getFunctionKey(fn, options);
    return originalMemoize.apply(this, arguments);
  };

	afterEach(async () => {
    await delKeys(client, `memos:${key_namespace}:*`);
  });

  after(() => {
		client.end(true);
  });

  it('should memoize a value correctly', async () => {
    const functionDelayTime = 10;
    let callCount = 0;
    const functionToMemoize = async (val1, val2) => {
      callCount++;
      await Promise.delay(functionDelayTime);
      return { val1, val2 };
    };
    const memoized = memoize(functionToMemoize, {name: 'fn1'});

    let start = Date.now();
    let { val1, val2 } = await memoized(1, 2);
    val1.should.equal(1);
    val2.should.equal(2);
    (Date.now() - start >= functionDelayTime).should.be.true;		// First call should go to the function itself
    callCount.should.equal(1);

    start = Date.now();
    ({ val1, val2 } = await memoized(1, 2));
    val1.should.equal(1);
    val2.should.equal(2);
    (Date.now() - start < functionDelayTime).should.be.true;		// Second call should be faster
    callCount.should.equal(1);
  });

  it('should memoize large values (gzip)', async () => {
    let callCount = 0;
    const functionToMemoize = async (val1) => {
      callCount++;
      return pkgJSON + val1;
    };
    const memoized = memoize(functionToMemoize, {name: 'pkg'});

    const json = await memoized(1);
    json.should.equal(pkgJSON + 1);
    callCount.should.equal(1);

    const json2 = await memoized(1);
    json2.should.equal(pkgJSON + 1);
    callCount.should.equal(1);
  });

  it('should memoize separate function separately', async () => {
    const function1 = async arg => { await Promise.delay(10); return 1; };
    const function2 = async arg => { await Promise.delay(10); return 2; };

    const memoizedFn1 = memoize(function1, {name: 'fn1'});
    const memoizedFn2 = memoize(function2, {name: 'fn2'});

    (await memoizedFn1('x')).should.equal(1);
    (await memoizedFn2('y')).should.equal(2);
    (await memoizedFn1('x')).should.equal(1);
  });

  it('should memoize same function with different args separately', async () => {
    const fn = async arg => { await Promise.delay(10); return arg; };

    const memoizedFn = memoize(fn, {name: 'fn_args'});

    (await memoizedFn('x')).should.equal('x');
    (await memoizedFn('y')).should.equal('y');
    (await memoizedFn('x')).should.equal('x');
  });

  async function stampede(options, memoizerOptions, memoizeOptions) {
    // this thing is crazy slow, breaks tests
    if (REDIS_TYP === 'fakeredis') return memoizerOptions.lock_retry_delay * 10;

    if (!options.delayTime || !options.iters) throw new Error('bad args', options);
    let callCount = 0;
    const do_memoize = memoizePkg(client, {
      ...makeDefaultOptions(),
      ...memoizerOptions,
    });

    const fn = async () => {
      callCount++;
      await Promise.delay(options.delayTime);
    };
    const memoized = do_memoize(fn, memoizeOptions);

    let start = Date.now();
    await Promise.all([ ...Array(options.iters).keys() ].map(() => memoized()));
    let duration = Date.now() - start;
    callCount.should.equal(1);
    return duration;
  }

  it('should prevent a cache stampede (slow lock)', async () => {
    const options = {delayTime: 10, iters: 10};
    const duration = await stampede(options, {lock_retry_delay: 50}, {name: 'fn_lock_slow'});
    (duration).should.be.above(options.delayTime * options.iters);
  });

  it('should prevent a cache stampede (fast lock)', async () => {
    const options = {delayTime: 10, iters: 10};
    const duration = await stampede(options, {lock_retry_delay: 1}, {name: 'fn_lock_fast'});
    (duration).should.be.below(options.delayTime * options.iters);
  });

  it('should prevent a cache stampede (low lock timeout)', async () => {
    const options = {delayTime: 10, iters: 10};
    const duration = await stampede(options, {lock_retry_delay: 1}, {name: 'fn_lock_fast2', lock_timeout: 20});
    (duration).should.be.below(50);
  });

  it(`should respect 'this'`, async () => {
    function Obj() { this.x = 1; }
    Obj.prototype.y = async function() {
      await Promise.delay(10);
      return this.x;
    };

    const obj = new Obj();
    const memoizedY = memoize(obj.y, {name: 'fn_this'}).bind(obj);

    (await memoizedY()).should.equal(1);
  });

  it('should respect the ttl', async () => {
    const ttl = 100;
    const functionDelayTime = 10;

    const fn = () => Promise.delay(functionDelayTime);
    const memoized = memoize(fn, {name: 'fn1', ttl});

    let start = Date.now();
    await memoized();
    (Date.now() - start >= functionDelayTime).should.be.true;

    // Call immediately again. Should be a cache hit.
    start = Date.now();
    await memoized();
    (Date.now() - start < functionDelayTime).should.be.true;

    // Wait some time, ttl should have expired
    await Promise.delay(ttl + 10);
    start = Date.now();
    await memoized();
    (Date.now() - start >= functionDelayTime).should.be.true;
  });

  it('should allow ttl to be a function', async () => {
    const functionDelayTime = 10;
    const ttl = 100;
    const fn = () => Promise.delay(functionDelayTime);
    const memoized = memoize(fn, {name: 'fn1', ttl: () => ttl});

    let start = Date.now();
    await memoized();
    (Date.now() - start >= functionDelayTime).should.be.true;

    // Call immediately again. Should be a cache hit
    start = Date.now();
    await memoized();
    (Date.now() - start <= functionDelayTime).should.be.true;

    // Wait some time, ttl should have expired;
    await Promise.delay(ttl + 10);

    start = Date.now();
    await memoized();
    (Date.now() - start >= functionDelayTime).should.be.true;
  });

  // FIXME this test is flaky when failing
  it('should gracefully fail lookup timeout', async () => {
    const fn = () => 1;
    const do_memoize = memoizePkg(client, {
      ...makeDefaultOptions(),
      lookup_timeout: -1,
    });

    const memoized = do_memoize(fn, {name: 'timeout_fn', ttl: 1000});

    const res = await memoized();
    res.should.equal(1);
  });

  it('should work if complex types are accepted and returned', async () => {
    const functionDelayTime = 10;
    const fn = async (arg1) => {
      await Promise.delay(functionDelayTime);
      return { arg1, some: ['other', 'data'] };
    };

    const memoized = memoize(fn, {name: 'fn1'});

    let start = Date.now();
    let { arg1, some } = await memoized({ input: 'data' });
    (Date.now() - start >= functionDelayTime).should.be.true;
    arg1.should.eql({ input: 'data' });
    some.should.eql(['other', 'data']);

    start = Date.now();
    ({ arg1, some } = await memoized({ input: 'data' }));
    (Date.now() - start <= functionDelayTime).should.be.true;
    arg1.should.eql({ input: 'data' });
    some.should.eql(['other', 'data']);
  });

  it('should memoize even if result is falsy', async () => {
    await Promise.all([undefined, null, false, ''].map(async (falsyValue, i) => {
      let callCount = 0;
      const fn = async () => {
        callCount++;
        return falsyValue;
      };

      const memoized = memoize(fn, {name: 'falsy_fn' + i});

      (await memoized() === falsyValue).should.be.true;
      (await memoized() === falsyValue).should.be.true;  // Repeated, presumably cache-hit
      callCount.should.equal(1);  // Verify cache hit
    }));
  });

  it(`shouldn't memoize errors by default`, async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      throw new Error('Test error');
    };

    const memoized = memoize(fn, {name: 'fn1'});

    try {
      await memoized();
    } catch(e) {
      callCount.should.equal(1);
    }

    try {
      await memoized();
    } catch(e) {
      callCount.should.equal(2);
    }
  });

	it(`should restore Date objects, not strings`, async () => {
		const date1 = new Date("2000-01-01T00:00:00.000Z");
		const date2 = new Date("2000-01-02T00:00:00.000Z");

		const fn = async (arg1) => {
			await Promise.delay(500);
			return [arg1, date2];
		};
		const memoized = memoize(fn, {name: 'fn1'});

		let start = Date.now();
		let [val1, val2] = await memoized(date1);
		(Date.now() - start >= 500).should.be.true;
		val1.should.be.an.instanceOf(Date);
		val2.should.be.an.instanceOf(Date);
		val1.should.eql(date1);
		val2.should.eql(date2);

		start = Date.now();
		[val1, val2] = await memoized(date1);
		(Date.now() - start <= 100).should.be.true;
		val1.should.be.an.instanceOf(Date);
		val2.should.be.an.instanceOf(Date);
		val1.should.eql(date1);
		val2.should.eql(date2);
	});

	it('should memoize errors when indicated', async function() {
		let hits = 0;
		async function errorFunction() {
			hits++;
			if (hits === 1) throw new Error('Hit Error #' + hits);
		}

		const do_memoize = memoizePkg(client, {
      ...makeDefaultOptions(),
			memoize_errors_when: () => true,
		});

		const memoized = do_memoize(errorFunction, {name: 'fn1', ttl: 1000});
		await memoized().should.be.rejectedWith(Error, { message: 'Hit Error #1' });
		await memoized().should.be.rejectedWith(Error, { message: 'Hit Error #1' });
	});

	it('should not memoize errors that are filtered out', async function() {
		let hits = 0;
		function errorFunction() {
			hits++;
			if (hits === 1) throw new Error('Hit Error!');
			else if (hits === 2) throw new Error('Special Error!');
			return hits;
		}

		const do_memoize = memoizePkg(client, {
      ...makeDefaultOptions(),
			memoize_errors_when: function(err) {
				return err.message !== 'Hit Error!';
			}
		});

		// First error won't be memoized, so expect hits to increment on subsequent calls.
		// Second error will, so hits will freeze there.
		const memoized = do_memoize(errorFunction, {name: 'fn2', ttl: 1000});
		await memoized().should.be.rejectedWith(Error, { message: 'Hit Error!' });
		hits.should.eql(1);

		await memoized().should.be.rejectedWith(Error, { message: 'Special Error!' });
		hits.should.eql(2);

		// Should stick here as it was memoized
		await memoized().should.be.rejectedWith(Error, { message: 'Special Error!' });
		hits.should.eql(2);
	});

	it('should not memoize two identical-looking functions to the same key', async function() {
		const funcA = (function() {
			const a = 10;
			return async () => a;
		})();
    funcA._name = 'a';
		const funcB = (function() {
			const a = 20;
			return async () => a;
		})();
    funcB._name = 'b';

		const memoizedA = memoize(funcA, {});
		const memoizedB = memoize(funcB, {});
		const result1 = await memoizedA();
		result1.should.eql(10);

		const result2 = await memoizedB();
		result2.should.eql(20);
	});
});
