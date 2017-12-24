const Redis = require('ioredis');
const crypto = require('crypto');
const should = require('should');
const Promise = require('bluebird');

const key_namespace = Date.now();
const memoizePkg = require('../');
const client = new Redis({port: 6780});
let memoize = memoizePkg(client, {memoize_key_namespace: key_namespace, memoize_errors_when: () => false});

const hash = string => crypto.createHmac('sha1', 'memo').update(string).digest('hex');

const originalMemoize = memoize;
// Record the name so we can clear this out
memoize = function(fn, options) {
  // Ensures we can't clobber our own names
  fn._name = String(Math.random()) + memoizePkg.getFunctionKey(fn, options);
  return originalMemoize.apply(this, arguments);
};

function clearCache(fn, args = []) {
  const stringified = JSON.stringify(args);
  return client.del(['memos', key_namespace, memoizePkg.getFunctionKey(fn, {}), hash(stringified)].join(':'));
}

async function delKeys(keyPattern) {
  const keys = await client.keys(keyPattern);
  return await Promise.map(keys, (key) => client.del(key));
}

describe('redis-memoizer', () => {

  before(async () => {
    await delKeys(key_namespace + ':*');
  });

	after(async () => {
    await delKeys(key_namespace + ':*');
		client.end();
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

    await clearCache(functionToMemoize, [1, 2]);
  });

  it('should memoize separate function separately', async () => {
    const function1 = async arg => { await Promise.delay(10); return 1; };
    const function2 = async arg => { await Promise.delay(10); return 2; };

    const memoizedFn1 = memoize(function1, {name: 'fn1'});
    const memoizedFn2 = memoize(function2, {name: 'fn2'});

    (await memoizedFn1('x')).should.equal(1);
    (await memoizedFn2('y')).should.equal(2);
    (await memoizedFn1('x')).should.equal(1);

    await clearCache(function1, ['x']);
    await clearCache(function2, ['y']);
  });

  xit('should prevent a cache stampede', async () => {
    const functionDelayTime = 10;
    const iterationCount = 10;
    let callCount = 0;

    const fn = async () => {
      callCount++;
      await Promise.delay(functionDelayTime);
    };
    const memoized = memoize(fn, {name: 'fn1'});

    let start = Date.now();
    await Promise.all([ ...Array(iterationCount).keys() ].map(() => memoized()));
    (Date.now() - start < functionDelayTime * iterationCount).should.be.true;
    callCount.should.equal(1);

    await clearCache(fn);
  });

  it(`should respect 'this'`, async () => {
    function Obj() { this.x = 1; }
    Obj.prototype.y = async function() {
      await Promise.delay(10);
      return this.x;
    };

    const obj = new Obj();
    const memoizedY = memoize(obj.y, {name: 'fn1'}).bind(obj);

    (await memoizedY()).should.equal(1);

    await clearCache(Obj.prototype.y);
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

    await clearCache(fn);
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

    await clearCache(fn);
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

    await clearCache(fn, [{input: "data"}]);
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

      await clearCache(fn);
    }));
  });

  it(`shouldn't memoize errors`, async () => {
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

		await clearCache(fn, date1);
	});

	it('should memoize errors', async function() {
		let hits = 0;
		async function errorFunction() {
			hits++;
			if (hits === 1) throw new Error('Hit Error #' + hits);
		}

		const do_memoize = memoizePkg(client, {
			memoize_key_namespace: Date.now(),
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
			memoize_key_namespace: Date.now(),
			memoize_errors_when: function(err) {
				return err.message !== 'Hit Error!';
			}
		});

		// First error won't be memoized, so expect hits to increment on subsequent calls.
		// Second error will, so hits will freeze there.
		const memoized = do_memoize(errorFunction, {name: 'fn1', ttl: 1000});
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
