use serde_json::{json,Value};
use sldkit_core::{ResourceLimits,ParseStatus,ValueOrigin,DocumentKind,BinaryResourceKind,ExtractionStatus,DiagnosticKind};
fn result(bytes:&[u8],kind:u32)->Result<Value,String>{
let mut limits=ResourceLimits::service();limits.max_file_size=32*1024*1024;limits.max_total_uncompressed_bytes=64*1024*1024;limits.max_stream_count=10000;limits.max_string_bytes=1024*1024;limits.max_xml_stream_bytes=4*1024*1024;limits.max_xml_nodes=50000;limits.max_nesting_depth=32;
let parsed=sldkit_parser::parse_bytes(bytes,Some(if kind==0{"source.sldprt"}else{"source.sldasm"}),&limits);
if !matches!(parsed.status,ParseStatus::Parsed|ParseStatus::Partial){return Err(format!("Native SolidWorks parse {:?}: {:?}",parsed.status,parsed.diagnostics));}
let doc=parsed.document.as_ref().ok_or("No native SolidWorks document")?;
if doc.document_kind.origin!=ValueOrigin::Source || doc.document_kind.value!=if kind==0{DocumentKind::Part}else{DocumentKind::Assembly}{return Err("Native document type is absent or differs from extension".into());}
if parsed.diagnostics.iter().any(|d|matches!(d.kind,DiagnosticKind::Malformed|DiagnosticKind::Fatal)){return Err(format!("Malformed native stream: {:?}",parsed.diagnostics));}
let preview=if let Some(resource)=&doc.preview {if matches!(resource.kind,BinaryResourceKind::PreviewPng){if resource.byte_len>4*1024*1024{return Err("PNG preview exceeds 4 MiB".into());}let extracted=sldkit_parser::extract_resource_bytes(bytes,resource,&limits);if extracted.result.status!=ExtractionStatus::Extracted{return Err(format!("Preview extraction: {:?}",extracted.result));}Some(extracted.data.ok_or("Missing extracted PNG")?)}else{None}}else{None};
let mut value=serde_json::to_value(parsed).map_err(|e|e.to_string())?;value["png"]=json!(preview);Ok(value)
}
#[unsafe(no_mangle)]pub extern "C" fn allocate(length:u32)->u32{if length>32*1024*1024{return 0;}let b=vec![0u8;length as usize].into_boxed_slice();Box::into_raw(b) as *mut u8 as u32}
// Buffers are created by this module, used once by one dedicated worker, and
// returned with their original length. No caller-provided arbitrary pointers.
#[unsafe(no_mangle)]pub unsafe extern "C" fn release(pointer:u32,length:u32){unsafe{drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(pointer as *mut u8,length as usize)));}}
#[unsafe(no_mangle)]pub unsafe extern "C" fn decode(pointer:u32,length:u32,kind:u32)->u64{let data=unsafe{std::slice::from_raw_parts(pointer as *const u8,length as usize)};let value=if length>32*1024*1024||kind>1{json!({"error":"Invalid SolidWorks input limits/kind"})}else{match result(data,kind){Ok(v)=>v,Err(e)=>json!({"error":e})}};let mut output=value.to_string().into_bytes();if output.len()>32*1024*1024{output=b"{\"error\":\"SolidWorks preview exceeds 8 MiB\"}".to_vec();}let output=output.into_boxed_slice();let length=output.len() as u64;let pointer=Box::into_raw(output) as *mut u8 as u64;(length<<32)|pointer}
