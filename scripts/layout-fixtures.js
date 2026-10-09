// Original GDSII library with boundary, path and label records.
const i16=value=>{const b=Buffer.alloc(2);b.writeInt16BE(value);return b;};
const record=(type,dataType,data=Buffer.alloc(0))=>{if(data.length%2)data=Buffer.concat([data,Buffer.alloc(1)]);const header=Buffer.alloc(4);header.writeUInt16BE(data.length+4);header[2]=type;header[3]=dataType;return Buffer.concat([header,data]);};
const xy=points=>{const b=Buffer.alloc(points.length*8);points.forEach(([x,y],i)=>{b.writeInt32BE(x,i*8);b.writeInt32BE(y,i*8+4);});return b;};
function fixture(){return Buffer.concat([record(0,2,i16(600)),record(1,2,Buffer.alloc(24)),record(2,6,Buffer.from('Original')),record(5,2,Buffer.alloc(24)),record(6,6,Buffer.from('CELL')),record(8,0),record(13,2,i16(1)),record(14,2,i16(0)),record(16,3,xy([[0,0],[100,0],[100,100],[0,100],[0,0]])),record(17,0),record(9,0),record(13,2,i16(2)),record(16,3,xy([[10,10],[90,90]])),record(17,0),record(12,0),record(13,2,i16(3)),record(16,3,xy([[20,20]])),record(25,6,Buffer.from('<script>safe</script>')),record(17,0),record(7,0),record(4,0)]);}
module.exports={fixture};
