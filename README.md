redis-memoizer
===

An asynchronous function memoizer for node.js, using redis as the memo store. Memos expire after a specified timeout. Great as a drop-in performance optimization / caching layer for heavy asynchronous functions.

Wikipedia [explains it best](http://en.wikipedia.org/wiki/Memoization):
> ...memoization is an optimization technique used primarily to speed up computer programs by having function calls avoid repeating the calculation of results for previously processed inputs.

```javascript
const redisClient = require('redis').createClient(port, host, options)
const memoize = require("redis-memoizer")(redisClient);

async function someExpensiveOperation(arg1, arg2) { /* ... */}

const memoized = memoize(someExpensiveOperation);
```

Now, calls to `memoized` will have the same effect as calling `someExpensiveOperation`, except it will be much faster. The results of the first call are stored in redis and then looked up for subsequent calls.

Redis effectively serves as a shared network-available cache for function calls. Thus, the memoization cache is available across processes, so that if the same function call is made from different processes they will reuse the cache.

## Changes

Version 2 is Promise-first and no longer supports callbacks. If you want to support a callback function,
promisify it first.

Version 2 is similar to the `master` branch of https://github.com/errorception/redis-memoizer but introduces
a few extra options, gzip support, support for reifying Errors and Dates and assumes promises everywhere. The
locking mechanism is also less strict and gives up sooner, assuming it is not catastrophic to calculate an expensive
fn more often if it reduces overall latency.

## Uses

Lets say you are making a DB call that's rather expensive. Let's say you've wrapped the call into a `getUserProfile` function that looks as follows:

```javascript
function getUserProfile(userId) {
	// Go over to the DB, perform expensive call, get user's profile
	return User.get(userId); // some promise
}
```

Let's say this call takes 500ms, which is unacceptably high, and you want to make it faster, and don't care about the fact that the value of `userProfile` might be slightly outdated (until the cache timeout is hit in redis). You could simply do the following:

```javascript
const getMemoizedUserProfile = memoize(getUserProfile);

// First call. This will take some time.
const userProfile = await getMemoizedUserProfile("user1");


// Second call. This will be blazingly fast.
const userProfile2 = await getMemoizedUserProfile("user1");

```

This can similarly be used for any network or disk bound async calls where you are tolerant of slightly outdated values.

## Usage

### Initialization

Creates a memoization function. Requires an existing redis client.

```javascript
const memoize = require("redis-memoizer")(redisClient, {
	// Properties prefixed with `default_` can be overridden when creating each memoized function.
	// How long to persist memoized results to Redis. This can be overridden per-fn.
	default_ttl: 120000,
	// How long to wait for the lock (including retries)
	default_lock_timeout: 5000,

	// How long to wait on Redis before just moving on.
  // If the TTL fed to `memoize` is shorter than this, it will be used instead.
	lookup_timeout: 1000, // ms
	// Set to a function that determines whether or not to memoize an error. By default, we never do.
	memoize_errors_when: (err) => false,
	// Namespace to use under `memos:` in redis. Useful to e.g. invalidate all cache after
  // an application update; simply set this to the current git revision or use the boot timestamp.
	memoize_key_namespace: null,
	// How often to spin on the lock
	lock_retry_delay: 50,

	// This is *required*, below is an example
	on_error: (err, client, key) => console.error(err),

	// Optional customizations. You don't have to touch these, but in certain
	// cases it might be useful to. They're provided here so you don't have
	// to fork the module to make these changes.

	// Serialize a value to a string before sending to redis.
	serialize_value(value, options) { ... },
	// Given a string, deserialize back to a JS object.
	deserialize_value(value, options) { ... },
	// For convenience, the default (de)serialization methods reference these
	// when dealing with errors. They are easy to override if you have
	// custom attributes, like e.g. `statusCode`.
	// 'message' is always present.
	error_serialization_keys: ['name', 'stack']

    // Optional event emitter that subscribes to internal events, see "Events' section below.
        emitter: new EventEmitter()
});
```

### memoize(asyncFunction: Function, options: {ttl?: number | (result: any?) => number, lock_timeout?: number, name: string})

Memoizes an async function and returns it.

* `asyncFunction` must be an asynchronous function that needs to be memoized. The function should return a Promise.

* `name` (`string`) *Required* identifier for this function. As of v2 this is required as we have found no perfect way to uniquely
identify a function (many functions look alike, like Promisify wrappers), while making the identifier consistent across processes.
Make sure this is unique across your application.

* `ttl` (`?number | (result?) => number`) (Default: 120000 (ms)) is the amount of time in milliseconds for which the result of the function call should be cached in redis. Once the timeout is hit, the value is deleted from redis automatically. This is done using the redis [`psetex` command](http://redis.io/commands/psetex). The timeout is only set the first time, so the value expires after the timeout time has expired since the first call. The timeout is not reset with every call to the memoized function. Once the value has expired in redis, this module will treat the function call as though it's called the first time again. `ttl` can alternatively be a function, if you want to dynamically determine the cache time based on the data returned. The returned data will be passed into the timeout function, but not always (for calculating minimums).

* `lock_timeout` (`?number`) This is how long to check spinlock when there isn't a result in Redis. See "Cache Stampedes" below. By default, this is 50ms. You may want to set
this lower for faster response times when multiple identical functions are called at the same time, but it will increase the load on Redis.


```javascript
const httpCallMemoized = memoize(makeHttpCall);
const res = await httpCallMemoized(options);
```

## Cache Stampedes

This module makes some effort to minimize the effect of a [cache stampede](http://en.wikipedia.org/wiki/Cache_stampede). If multiple calls are made in quick succession before the first (async) call has completed, only the first call is actually really made. Note that redis will not have been populated at this time yet. Subsequent calls are queued up and are responded to as soon as the result of the first call is available.

Once all the calls have been responded to and the result of the computation is stored in redis, the module then switches to using the computed values from redis.

Note, cache stampedes can still happen if the same function is called from different processes, since the queueing logic described above happens in-memory. For the same set of arguments, you are likely to make as many calls as you have processes.

## Types

Note that this module does serialization to JSON. Special affordances are made for Date objects, which will be correctly returned
as Dates, but other, more complex types (like Functions) will not survive the serialization/deserialization.

## Events

The memoizer is instrumented with an event emitter. At initialization time an optional emitter can be passed as an option. This emitter emits the following events.

* `miss`
Triggers on a cache miss for functionKey.
```javascript
  emitter.on('miss', (functionKey) => {});
```
* `hit`
Triggered on a cache hit for functionKey.
```javascript
  emitter.on('hit', (functionKey) => {});
```

* `lookupTimeout`
Triggered when a lookup times out.
```javascript
  emitter.on('lookupTimeout', (functionKey) => {})
```

* `lookup`
Triggered when a lookup completes and passes the time taken.
```javascript
  emitter.on('lookup', (functionKey, timeTaken) => {})
```

* `unlock`
Triggered when a cache query is unlocked and passes the time taken.
```javascript
  emitter.on('unlock', (functionKey, timeTaken) => {})
```


* `error`
Triggered on a general error from the cache.
```javascript
  emitter.on('error', (functionKey) => {})
```




## Installation

Use npm to install redis-memoizer:
```
npm install redis-memoizer
```

To run the tests, install the dev-dependencies by `cd`'ing into `node_modules/redis-memoizer` and running `npm install` once, and then `npm test`.

## License

(The MIT License)

Copyright (c) 2012 Rakesh Pai <rakeshpai@errorception.com>

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
