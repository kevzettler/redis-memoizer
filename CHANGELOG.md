# 5.0.0 (Apr 5, 2018)

* Breaking: Errors no longer serialize `type`
* Breaking: `on_error` is no longer called for TimeoutErrors
* Feature: Added `serialize_value(value: any, options: Options) => string` and `deserialize_value(value: string, options: Options) => any` options if you need deep customization.
* Feature: Added `error_serialization_keys` convenience array. Use if you have custom error keys such as `statusCode`.
* Refactored some functions and exports.

# 4.0.0 (Jan 30, 2018)

* Breaking: Remove `error_logging` option and move to required `on_error` function with arity `(err: Error, client: RedisClient, key: string) => void`.

# 3.0.0 (Jan 19, 2018)

* Breaking: `error_logging` option is now a function of arity `(client: RedisClient, key: string) => boolean` rather than a bool.

# 2.1.2 (Dec 24, 2017)

* Fix: Lookup timeouts could return `undefined`

# 2.1.1 (Dec 24, 2017)

* Fix: Fix handling of Buffers in ioredis

# 2.1.0 (Dec 24, 2017)

* Feature: Add node_redis and fakeredis compatibility in library and test.

# 2.0.0 (Dec 24, 2017)

* Breaking: Library now uses Promises everywhere, not callbacks.
* Breaking: `name` option is now required when memoizing functions. Automatically determining function uniqueness is impractical across multiple running processes. Provide a unique name instead and the memoizer will use it as a key. This helps us reliably share results across many services.
* Breaking: Move compatibility to Node >= 8.
* Feature: New locking implementation.

# 0.6.0 (Oct 10, 2017)

* Feature: ioredis support

# 0.5.2 (July 28, 2017)

* Feature: Export uuid & hash functions
* Performance: Avoid assigning properties to input functions to avoid conversion to slow object
* Fix: Memory leak on `inFlight`
* Test: Use `fakeredis`

# 0.5.1 (June 22, 2017)

* Fix: Error when gzipping exotic objects

# 0.5.0 (Mar 08, 2017)

* Breaking: drop Node < 4 support
* Refactor: Use a proper uuid library

> See the commit history for prior revisions.
