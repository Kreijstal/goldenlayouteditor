# Scientific data viewer

The lazy scientific panel reads `.h5`, `.hdf`, `.hdf5`, `.he5`, `.nc`, `.nc4`, `.netcdf`, `.npy`, and `.npz`. Select or search hierarchy entries to inspect shapes, types, attributes and stored values. The scope of `.hdf` is HDF5; HDF4 is unsupported.

Readers are pinned to NIST **h5wasm 0.10.0**, **netcdfjs 3.0.0**, and **npyjs 1.0.4**. ZIP arrays use JSZip. Each file gets a module worker that terminates after parsing or when the panel closes. All assets are local. Dynamic imports keep the HDF5 WASM out of NumPy/NetCDF-3 loads. NIST is acknowledged as the source of h5wasm; its complete notice is retained and its implementation is unmodified.

HDF5 and NetCDF-4 decode datasets through the HDF5 C library, including supported compression filters. A preview reads the first line of each multidimensional dataset, up to 100 elements. Variable-length/oversized elements show metadata only. Null/empty dataspaces are labeled. Attributes above 64 KiB show their limit rather than being read. Hierarchies stop with an error above 500 nodes or 24 group levels. External files and custom filter plugins are not provided.

NetCDF-3 classic and 64-bit-offset files decode names, dimensions, attributes and values. Variables exceeding one million elements show metadata only. CDF-5 is unsupported. Values are stored values: CF scale/offset/missing-value conventions are not applied.

NumPy reads numeric and boolean scalar dtypes in NPY versions 1–3, including scalar/multidimensional shapes, Fortran storage order and big-endian payloads. We normalize big-endian numeric bytes in the adapter because npyjs 1.0.4's typed-array path ignores endianness; the original dtype remains visible. Object/pickled, structured, complex and string dtypes are unsupported. NPZ arrays can be ZIP-deflated. Previews show up to 100 values in storage order. Archives have a 500-array and 64 MiB expanded limit; every input has a 64 MiB limit.

`npm run build:scientific` produces the ignored local worker/chunks. `npm run build` includes it. `npm run test:scientific` tests compressed HDF5 authored with h5py, attributes, NetCDF float values, compressed NPZ, NPY big endian/Fortran order, dataset selection/search, malformed input, termination, cancellation, caching and zero startup requests. The HDF5 fixture is our own small dataset, not third-party scientific data.

Licenses are retained under `public/licenses/imported-viewers/`: h5wasm's complete NIST/HDF5/dependency notice, netcdfjs MIT, npyjs Apache-2.0 and JSZip's license.
