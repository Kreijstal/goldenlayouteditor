// Authored structured binary records, containing only public synthetic data.
function fixtures(){
 const string=Buffer.from('Original\0'),length=Buffer.alloc(4);length.writeInt32LE(string.length);const integer=Buffer.alloc(4);integer.writeInt32LE(42);
 const contents=Buffer.concat([Buffer.from([2]),Buffer.from('name\0'),length,string,Buffer.from([16]),Buffer.from('value\0'),integer,Buffer.from([8]),Buffer.from('flag\0'),Buffer.from([1,0])]);const size=Buffer.alloc(4);size.writeInt32LE(contents.length+4);
 const msgpack=Buffer.from('83a46e616d65a84f726967696e616ca576616c75652aa4666c6167c3','hex');return {mpk:msgpack,bson:Buffer.concat([size,contents]),cbor:Buffer.from('a3646e616d65684f726967696e616c6576616c7565182a64666c6167f5','hex'),msgpack:Buffer.from('83a46e616d65a84f726967696e616ca576616c75652aa4666c6167c3','hex')};
}
module.exports={fixtures};
