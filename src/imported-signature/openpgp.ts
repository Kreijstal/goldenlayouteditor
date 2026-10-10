import {readSignature,enums} from 'openpgp';
export async function inspectDetachedOpenPgp(bytes:Uint8Array){
 if(bytes.length>2*1024*1024)throw Error('OpenPGP signature exceeds 2 MiB');
 const config={ignoreMalformedPackets:false,ignoreUnsupportedPackets:false,maxDecompressedMessageSize:2*1024*1024};
 const armored=new TextDecoder('ascii').decode(bytes.subarray(0,64)).startsWith('-----BEGIN PGP SIGNATURE-----');
 const signature=await readSignature(armored?{armoredSignature:new TextDecoder('utf-8',{fatal:true}).decode(bytes),config}:{binarySignature:bytes,config});
 if(signature.packets.length<1||signature.packets.length>100)throw Error('OpenPGP signature packet count must be 1–100');
 const packets=Array.from(signature.packets,packet=>({version:packet.version,signatureType:packet.signatureType,publicKeyAlgorithm:enums.read(enums.publicKey,packet.publicKeyAlgorithm),hashAlgorithm:enums.read(enums.hash,packet.hashAlgorithm),created:packet.created?.toISOString(),issuerKeyId:packet.issuerKeyID?.toHex(),issuerFingerprint:packet.issuerFingerprint?Array.from(packet.issuerFingerprint,b=>b.toString(16).padStart(2,'0')).join(''):undefined,issuerKeyVersion:packet.issuerKeyVersion}));
 return{kind:'openpgp',detectedFormat:'OpenPGP detached signature',packets,signingKeyIds:signature.getSigningKeyIDs().map(key=>key.toHex()),cryptographicVerified:false,verificationStatus:'Not verified: signed data and a public key were not supplied.'};
}
