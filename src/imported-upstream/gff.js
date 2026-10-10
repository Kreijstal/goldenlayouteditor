// Native nine-column GFF2/GFF3/GTF records; source values remain text.
export function featureTable(text){
 const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const rows=[];let count=0;
 for(const line of text.split(/\r?\n/)){if(line==='##FASTA')break;if(!line.trim()||line.startsWith('#'))continue;const cols=line.split('\t');if(cols.length!==9||!/^\d+$/.test(cols[3])||!/^\d+$/.test(cols[4])||Number(cols[3])<1||Number(cols[4])<Number(cols[3]))throw Error('Invalid nine-column genome annotation record');count++;if(rows.length<1000)rows.push('<tr>'+cols.map(c=>'<td>'+esc(c)+'</td>').join('')+'</tr>');}
 if(!count)throw Error('No genome annotation records');return '<h4>Feature records ('+Math.min(count,1000)+' of '+count+')</h4><table><thead><tr>'+['Sequence','Source','Type','Start','End','Score','Strand','Phase','Attributes'].map(c=>'<th>'+c+'</th>').join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody></table>';
}
