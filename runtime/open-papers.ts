export function journalArchive(doi:string){
  const match=/^10\.21105\/(joss\.\d{5})$/.exec(doi);
  if(match)return 'https://raw.githubusercontent.com/openjournals/joss-papers/master/'+match[1]+'/10.21105.'+match[1];
}
export async function fetchBytes(url:string,signal:AbortSignal,max:number,transport:typeof fetch=fetch){
  const response=await transport(url,{signal,redirect:'error'});
  if(!response.ok||!response.body){await response.body?.cancel();throw Error('HTTP '+response.status);}
  const chunks:Uint8Array[]=[];let bytes=0;
  for await(const chunk of response.body as unknown as AsyncIterable<Uint8Array>){
    bytes+=chunk.length;if(bytes>max)throw Error('Open article exceeds the size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
