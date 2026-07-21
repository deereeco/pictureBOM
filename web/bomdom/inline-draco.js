// DRACOLoader that never touches the network: the wrapper JS is embedded as
// text and the wasm as gzip+base64 (generated into _generated_draco.js by
// scripts/build_viewer.mjs). DRACOLoader only uses _loadLibrary to fetch its
// two artifacts, then runs the decoder in a Blob-URL worker — which IS
// allowed on file:// pages. build_viewer.mjs asserts the private API exists.

import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { DRACO_WRAPPER_JS, DRACO_WASM_GZ_B64 } from './_generated_draco.js';
import { b64ToBytes, gunzipToArrayBuffer } from './payload.js';
import { diag } from './diag.js';

let wasmPromise = null;

export class InlineDRACOLoader extends DRACOLoader {
  _loadLibrary(url, responseType) {
    diag.dracoUsed = true;
    if (responseType === 'arraybuffer') {
      if (!wasmPromise) wasmPromise = gunzipToArrayBuffer(b64ToBytes(DRACO_WASM_GZ_B64));
      return wasmPromise;
    }
    return Promise.resolve(DRACO_WRAPPER_JS);
  }
}
