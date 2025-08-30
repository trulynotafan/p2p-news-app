
# Patch 1 (dht-relay)

## Problem

When a peer disconnected, the relay crashed with:

```
Error: uint must be positive
    at validateUint (compact-encoding/index.js:765)
    at Object.encode (compact-encoding/index.js:94)
    at Object.encode (dht-relay/lib/messages.js:193)
    ...
```

This crash occurred because the relay sent a `destroy` protocol message with an `alias` or `remoteAlias` value that was not a valid uint32 (such as `undefined`, `null`, or a negative number). The encoder requires a valid uint32, and any invalid value causes the process to terminate.

## Root Cause

- The relay’s disconnect and error handling logic sent `alias` or `remoteAlias` values that were not valid uint32 values to the message encoder in `lib/messages.js`.
- The encoder threw an error if the value was not a valid uint32, resulting in a crash.

## Solution

- The `destroy` message encoder in `lib/messages.js` now verifies that `alias` and `remoteAlias` are valid uint32 values before encoding.
- If the value is not valid, the encoder writes `0` (which is always valid and will not crash).
- This change ensures the relay never crashes due to malformed disconnect or error messages, regardless of upstream input.

## Code Change Summary

- Added a helper function to validate uint32 values.
- Updated the `destroy` message encoder to use this check and encode `0` if the value is invalid.


# Patch 2 (oplog browser compatibility for hypercore consistent storage)

## Problem

The original `oplog` module used `fs.truncate` to resize its storage file. This works in Node.js but **fails in browser environments**, where filesystem APIs like `truncate()` are unavailable or unsupported. As a result, the module could not function correctly in browsers.

## Root Cause

- `this.storage.truncate(...)` is called directly in methods like `open()` and `_writeHeaderAndTruncate()`.
- In a browser context (such as with IndexedDB-backed storage), this API does not exist, leading to runtime errors or incorrect behavior.

## Solution

- Implemented a **"virtual truncation"** system to simulate truncation behavior when `storage.truncate` is missing.
- Introduced `_virtualSize` to track the intended file size.
- Modified read/write operations (`_readAll`, `_append`, `open`) to honor `_virtualSize`.
- Added helper methods:
  - `_truncate(size)` – Handles truncation logic for both Node and browser.
  - `_rebuildStorageAfterTruncate(size)` – Rewrites the storage up to the truncation point.
  - `_overwriteStorage(newData)` – Replaces full storage content.
  - `_clearRemainingData(fromOffset)` – Zeros out data beyond truncation limit.

## Code Change Summary

- Detect browser environment using `typeof window !== 'undefined'`.
- Replace direct calls to `storage.truncate(...)` with `_truncate(...)`.
- Apply `_virtualSize` everywhere needed to simulate correct behavior.
- Reset virtual state on `close()`.

## Example Before

```js
this.storage.truncate(size, err => {
  if (err) return reject(err)
  resolve()
})
```

## Example After

```js
this._truncate(size).then(resolve).catch(reject)
```




This patch allows `oplog` to run safely in both Node.js and browser environments without relying on unsupported filesystem operations.


# Patch 3 (blind-pairing)

## Problem

The problem is that blind-pairing uses RTT value from the rawstream and uses it find the closest channel. THe rawstream object does provide the object in nodejs when using RAWUDP streams but this RTT value isn't available in the Browser Websocket. This is proven via logging this objetc and using checks to identity. The problem is that when this conditional check is ran:
```javascript

       // In browser rtt is undefined

        const { rtt } = ch._mux.stream.rawStream
        if (rtt < closest) channel = ch

```
, `undefined` would always return false. This means it will never choose any channel and would silently fail.

## Root Cause

The root cause appears to be because of browsers using dht-relay and Websockets. Which don't have this `rtt` value property. This doc will be updated after more researching.


## Solution

- Added a condition in blind-pairing so that if the `rtt` object is undefined we will just 0 as the closest value.

## Code Change Summary

- This codition has been added before the rtt-value assignment: `const fixed_rtt = (rtt !== undefined && rtt !== null) ? rtt : 0`

## Example Before

```js
        const { rtt } = ch._mux.stream.rawStream

        if (rtt < closest) channel = ch
```

## Example After

```js
        try {
          const { rtt } = ch._mux.stream.rawStream
          console.log({rtt})
          // Handle undefined RTT in browser environment - use 0 as fallback
          const fixed_rtt = (rtt !== undefined && rtt !== null) ? rtt : 0
          if ( fixed_rtt < closest) {
            closest = fixed_rtt
            channel = ch
          }
        } catch (error) {
          // If RTT access fails completely, (haven't but still) still use the channel with fallback RTT of 0
          if (0 < closest) {
            closest = 0
            channel = ch
          }
        }
```
Find the whole code [here](https://www.diffchecker.com/IHbjbx0M/) (This link will be updated with github link once we finalize and add it into patch-package)



This patch allows `blind-pairing` to be successfully completed along both browser and node/bare environments.





