import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { ManagerError } from './orchestration.ts';

const execute = promisify(execFile);
export const templates = ['article', 'elsarticle-3p','IEEEtran','acmart'] as const;
export type Template = typeof templates[number];
export function template(value: unknown): Template {
  if (value !== 'article' && value !== 'elsarticle-3p' && value !== 'IEEEtran' && value !== 'acmart')
    throw new ManagerError('TEMPLATE_UNAVAILABLE', 'Choose article, elsarticle-3p, IEEEtran, acmart or a granted .tex template.');
  return value;
}
// Import only structural typesetting declarations. User macros are never executed.
export function readTemplate(source:string) {
  if(Buffer.byteLength(source)>65536)throw Error('LaTeX template exceeds 64 KiB.');
  const before=source.split(/^\s*\\begin\{document\}\s*$/m);
  if(before.length!==2)throw Error('The template must contain one document body.');
  const lines=before[0]!.split(/\r?\n/).map(line=>line.replace(/%.*$/,'').trim()).filter(Boolean);
  const cls=/^\\documentclass(?:\[([A-Za-z0-9,-]+)\])?\{(article|elsarticle|IEEEtran|acmart)\}$/.exec(lines[0]??'');
  if(!cls)throw Error('Unsupported template class or preamble. Choose a registered journal class.');
  const allowed=new Set(['10pt','11pt','12pt','a4paper','letterpaper','onecolumn','twocolumn','final','draft','3p','1p','5p','times','preprint','review','conference','journal','sigconf','manuscript','screen']);
  if(cls[1]?.split(',').some(opt=>!allowed.has(opt)))throw Error('Unsupported document class option.');
  const packages=/^\\usepackage(?:\[(T1|utf8|hidelinks)\])?\{(fontenc|inputenc|graphicx|booktabs|hyperref|amsmath|amssymb|url|microtype|natbib)\}$/;
  for(const line of lines.slice(1))if(!packages.test(line))throw Error('Unsupported template directive: '+line.slice(0,100));
  return {style:template(cls[2]==='elsarticle'?'elsarticle-3p':cls[2]),preamble:lines};
}
const escapes: Record<string,string> = {
  '\\':'\\textbackslash{}','{':'\\{','}':'\\}','$':'\\$','&':'\\&','#':'\\#','%':'\\%',
  '_':'\\_','^':'\\textasciicircum{}','~':'\\textasciitilde{}','<':'\\textless{}','>':'\\textgreater{}',
};
function literal(text:string) {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g,' ')
    .replace(/[\\{}$&#%_^~<>−×]|[⁺⁻⁰¹²³⁴⁵⁶⁷⁸⁹⁽⁾]+/gu,token=>{
      if(token==='−')return '\\ensuremath{-}';
      if(token==='×')return '\\ensuremath{\\times}';
      if(Object.hasOwn(escapes,token))return escapes[token]!;
      const exponent=token.normalize('NFKC').replaceAll('−','-');
      return '\\textsuperscript{\\ensuremath{'+exponent+'}}';
    });
}
export type PaperReference = {url:string;retrievedAt:string;title?:string;authors?:string[];date?:string};
function headingAt(lines:string[], index:number) {
  const line=lines[index]!.replace(/^\uFEFF/,'');
  const atx=/^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/.exec(line);
  if(atx)return {level:atx[1]!.length,text:atx[2]!.replace(/[ \t]+#+$/,'').trim(),size:1};
  const underline=/^ {0,3}(=+|-+)\s*$/.exec(lines[index+1]??'');
  if(underline && /\S/.test(line) && !/^\s*[|#]/.test(line))
    return {level:underline[1]![0]==='='?1:2,text:line.trim(),size:2};
}
function headingName(text:string) {
  return text.replace(/^(\*\*|__)(.+)\1$/,'$2').trim().replace(/:$/,'').toLowerCase();
}
function bibliographyHeading(text:string) {
  return /^(references|bibliography|works cited|literature cited)$/.test(headingName(text));
}
function startsWithTitle(lines:string[], heading:NonNullable<ReturnType<typeof headingAt>>, next:number, title:string) {
  if(bibliographyHeading(heading.text))return false;
  if(heading.text===title)return true;
  if(heading.level!==1 || /^(abstract|introduction|background|(?:materials and )?methods|methodology|results|discussion|conclusions?|appendix|acknowledg(e)?ments)$/.test(headingName(heading.text)))return false;
  // A sequence of top-level sections can start a manuscript that has no authored title.
  for(let i=next;i<lines.length;i++){
    const following=headingAt(lines,i);
    if(following)return following.level>1;
  }
  return true;
}
export function manuscriptTitleHeading(lines:string[],title:string) {
  const index=lines.findIndex(line=>line.trim());
  const heading=index<0?undefined:headingAt(lines,index);
  if(heading && startsWithTitle(lines,heading,index+heading.size,title))return {index,text:heading.text};
}
function referenceUrl(value:string) {
  try {
    const url=new URL(value);
    if(url.protocol==='https:' || url.protocol==='http:')return url;
  } catch { /* A prose citation can contain a bare DOI. */ }
}
function doiFromUrl(url:URL|undefined) {
  if(url && /^(?:dx\.)?doi\.org$/i.test(url.hostname)){
    try {return decodeURIComponent(url.pathname.slice(1)).toLowerCase();} catch {return undefined;}
  }
}
// Strip sentence and Markdown-link punctuation without dropping balanced parentheses in identifiers.
function identifierToken(text:string) {
  const token=text.replace(/[.,;:]+$/,'');
  const trailing=token.match(/\)+$/)?.[0].length??0;
  if(!trailing)return token;
  const extra=token.split(')').length-token.split('(').length;
  return extra>0?token.slice(0,-Math.min(extra,trailing)):token;
}
function referenceIdentities(entry:string) {
  const urls=Array.from(entry.matchAll(/https?:\/\/[^\s<>\[\]"*]+/gi),m=>referenceUrl(identifierToken(m[0])));
  const dois=Array.from(entry.matchAll(/\b10\.\d{4,9}\/[^\s<>\[\]"*]+/gi),m=>identifierToken(m[0]).toLowerCase());
  for(const url of urls){const doi=doiFromUrl(url);if(doi)dois.push(doi);}
  return {urls:urls.map(url=>url?.href),dois};
}
function titleInEntry(entry:string,title:string) {
  const plain=entry.normalize('NFKC').toLowerCase().replace(/[*_\x60]/g,'').replace(/\s+/g,' ');
  const name=title.normalize('NFKC').toLowerCase().replace(/[*_\x60]/g,'').replace(/\s+/g,' ').trim().replace(/\.$/,'');
  if(!name)return false;
  const start=plain.indexOf(name);
  return start>=0 && (start===0 || /[.,:;“"'()[\]\-]$/.test(plain.slice(0,start).trimEnd()))
    && (start+name.length===plain.length || /[.,;:!?”"')\]]/.test(plain[start+name.length]!));
}
function missingReferences(refs:readonly PaperReference[], authored:string[]) {
  if(!authored.length || !refs.length)return refs;
  const entries=authored.join('\n').split(/\n\s*\n|\n(?=\s*(?:\[\d+\]|\d+[.)]\s|[-*+]\s))/)
    .map(text=>({text,...referenceIdentities(text)}));
  return refs.filter(ref=>{
    const url=referenceUrl(ref.url),doi=doiFromUrl(url);
    return !entries.some(entry=>{
      if((doi && entry.dois.includes(doi)) || (url && entry.urls.includes(url.href)))return true;
      // A title alone cannot distinguish two editions with different retained identifiers.
      return !entry.dois.length && !entry.urls.length && ref.title && titleInEntry(entry.text,ref.title)
        && !refs.some(other=>other.url!==ref.url && other.title?.toLowerCase()===ref.title!.toLowerCase());
    });
  });
}
export type DiagramSource = {sourceId:string;content:string};
export type MeasuredSeries = {sourceId:string;rows:ReadonlyArray<Record<string,unknown>>};
function evidenceBlock(kind:string, caption:string, series:MeasuredSeries, xKey:string, yKey:string) {
  const {rows}=series;
  if(!rows.length||rows.length>256)throw Error('Choose a verified series of 1–256 conditions.');
  const values=rows.map(row=>{
    const x=row[xKey],y=row[yKey];
    if(!Object.hasOwn(row,xKey)||!Object.hasOwn(row,yKey)||typeof x!=='number'||typeof y!=='number'||!Number.isFinite(x)||!Number.isFinite(y))
      throw Error('A requested figure or table column is missing or nonnumeric.');
    return {x,y};
  });
  if(kind==='table'){
    const body=['\\par\\smallskip\\noindent '+literal(caption)+'\\par'];
    for(let offset=0;offset<values.length;offset+=24){
      body.push('\\noindent\\begin{tabular}{rr}',literal(xKey)+' & '+literal(yKey)+' \\\\','\\hline');
      for(const row of values.slice(offset,offset+24))body.push(literal(String(row.x))+' & '+literal(String(row.y))+' \\\\');
      body.push('\\end{tabular}\\par\\smallskip');
    }
    return body;
  }
  const xs=values.map(v=>v.x),ys=values.map(v=>v.y);
  const xmin=Math.min(...xs),xmax=Math.max(...xs),ymin=Math.min(...ys),ymax=Math.max(...ys);
  const scaled=(v:number,min:number,max:number,extent:number)=>{
    if(max===min)return extent/2;
    // Normalize first so opposite finite extremes cannot overflow their difference.
    const m=Math.max(Math.abs(min),Math.abs(max));
    return Number(((v/m-min/m)/(max/m-min/m)*extent).toFixed(2));
  };
  const axes=['\\put(24,17){\\line(1,0){145}}','\\put(24,17){\\line(0,1){58}}'];
  const points=values.map(({x,y})=>'\\put('+(24+scaled(x,xmin,xmax,145))+','+(17+scaled(y,ymin,ymax,58))+'){\\circle*{2.5}}');
  const label=(x:number,y:number,value:number,align:string)=>'\\put('+x+','+y+'){\\makebox(0,0)['+align+']{'+literal(String(Number(value.toPrecision(4))))+'}}';
  return ['\\par\\smallskip\\noindent\\begin{minipage}{\\linewidth}\\centering\\footnotesize',
    '\\setlength{\\unitlength}{0.9pt}\\begin{picture}(190,84)',...axes,...points,
    label(22,17,ymin,'r'),...(ymax===ymin?[]:[label(22,75,ymax,'r')]),label(24,8,xmin,'t'),...(xmax===xmin?[]:[label(169,8,xmax,'t')]),
    '\\end{picture}\\par '+literal(yKey)+' vs. '+literal(xKey)+'\\par '+literal(caption)+'\\end{minipage}\\par\\smallskip'];
}
export function manuscriptTex(title:string, markdown:string, style:Template,references?:readonly PaperReference[],preamble?:readonly string[],series:readonly MeasuredSeries[]=[],diagrams:readonly DiagramSource[]=[]) {
  const lines = markdown.split(/\r?\n/);
  const body:string[] = [];
  const titleHeading=manuscriptTitleHeading(lines,title);
  const authoredReferences:string[]=[];
  const sourceDois=new Set(references?.map(ref=>doiFromUrl(referenceUrl(ref.url))));
  let linkedDoi=false;
  function referenceText(line:string) {
    // Use only recognized DOI destinations with TeX-safe characters. Other text stays literal.
    let start=0, rendered='';
    for(const match of line.matchAll(/\b10\.\d{4,9}\/[^\s<>\[\]"*]+/gi)){
      const doi=identifierToken(match[0]);
      if(!/^[A-Za-z0-9./:_();-]+$/.test(doi) || !sourceDois.has(doi.toLowerCase()))continue;
      rendered+=literal(line.slice(start,match.index))+'\\href{https://doi.org/'+doi+'}{'+literal(doi)+'}';
      start=match.index+doi.length;
      linkedDoi=true;
    }
    return rendered+literal(line.slice(start));
  }
  let referencesLevel=0, referencesEnd:number|undefined;
  let i=0;
  while(i<lines.length) {
    const index=i;
    const heading=headingAt(lines,i);
    const line=lines[i++]!;
    if(heading) {
      i=index+heading.size;
      const bibliography=bibliographyHeading(heading.text);
      if(index===titleHeading?.index){
        title=heading.text;
        continue;
      }
      if(referencesLevel && heading.level<=referencesLevel){referencesEnd=body.length;referencesLevel=0;}
      if(bibliography){referencesLevel=heading.level;authoredReferences.push('');}
      body.push('\\'+(heading.level<=2?'section':'subsection')+'*{'+literal(heading.text)+'}');
    } else if(/^\|.*\|\s*$/.test(line) && /^\|[\s|:-]+\|\s*$/.test(lines[i]??'')) {
      const cells=(s:string)=>s.trim().slice(1,-1).split('|').map(v=>literal(v.trim()));
      const header=cells(line);
      if(header.length>8) throw Error('A table has more than eight columns. Split it before typesetting.');
      const row=(s:string[])=>s.join(' & ')+' \\\\';
      body.push('\\par\\smallskip\\noindent\\begin{tabular}{'+'l'.repeat(header.length)+'}',row(header),'\\hline');
      i++;
      while(i<lines.length && /^\|.*\|\s*$/.test(lines[i]!)) {
        const data=cells(lines[i++]!);
        if(data.length!==header.length) throw Error('A table row has a different number of columns.');
        body.push(row(data));
      }
      body.push('\\end{tabular}\\par\\smallskip');
    } else if(/!\[[^\]]*\]\([^)]+\)/.test(line)) {
      const diagram=/^!\[([^\]]{1,300})\]\(athena-diagram:([a-f0-9]{64})\/([^\s)]{1,1200})\)$/.exec(line.trim());
      if(diagram){
        const source=diagrams.find(s=>s.sourceId===diagram[2]);
        const nodes=diagram[3]!.split('/').map(decodeURIComponent);
        if(!source||nodes.length<2||nodes.length>6||nodes.some(n=>!n.trim()||n.length>52||/[\r\n]/.test(n)))
          throw Error('Choose two to six short labels from a linked full-text source for the method diagram.');
        let offset=0;
        for(const label of nodes){
          const i=source.content.indexOf(label,offset);
          if(i<0)throw Error('A method diagram label is missing or out of order in its pinned source.');
          offset=i+label.length;
        }
        body.push('\\begin{center}\\begin{minipage}{.85\\linewidth}\\centering',
          ...nodes.flatMap((n,i)=>[...(i?['$\\downarrow$\\par']:[]),'\\fbox{\\strut '+literal(n)+'}\\par']),
          '\\smallskip '+literal(diagram[1]!)+'\\end{minipage}\\end{center}');
        continue;
      }
      const link=/^!\[([^\]]{1,300})\]\(athena-(plot|table):([a-f0-9]{64})\/([^/\s)]{1,128})\/([^/\s)]{1,128})\)$/.exec(line.trim());
      if(link){
        const data=series.find(s=>s.sourceId===link[3]);
        if(!data)throw Error('The requested figure or table lacks a reviewed experiment source.');
        body.push(...evidenceBlock(link[2]!,link[1]!,data,decodeURIComponent(link[4]!),decodeURIComponent(link[5]!)));
        continue;
      }
      throw Error('The manuscript references an unstaged figure. Supply a verified table or edit and review a revision with the figure resolved.');
    } else {
      if(referencesLevel)authoredReferences.push(line);
      body.push(referencesLevel?referenceText(line):literal(line));
    }
  }
  if(referencesLevel)referencesEnd=body.length;
  const required=missingReferences(references??[],authoredReferences);
  if(required.length){
    const supplement=referencesEnd===undefined?['\\section*{References}']:[];
    for(const r of required){
      const url=Array.from(r.url,c=>literal(c)+('/.-_'.includes(c)?'\\allowbreak{}':'')).join('');
      const byline=r.authors?.length?r.authors.slice(0,12).join(', ')+(r.authors.length>12?' et al.':''):'';
      const citation=[byline,r.date,r.title].filter(Boolean).map(part=>literal(String(part))).join('. ');
      supplement.push('\\par\\noindent '+(citation?citation+'. ':'')+url+' (accessed '+literal(r.retrievedAt.slice(0,10))+').\\par');
    }
    body.splice(referencesEnd??body.length,0,...supplement);
  }
  const front=style==='elsarticle-3p'
    ? ['\\documentclass[final,3p]{elsarticle}','\\begin{document}','\\begin{frontmatter}','\\title{'+literal(title)+'}','\\end{frontmatter}']
    : [style==='article'?'\\documentclass[11pt]{article}':style==='IEEEtran'?'\\documentclass[conference]{IEEEtran}':'\\documentclass[manuscript]{acmart}','\\title{'+literal(title)+'}','\\author{}','\\date{}','\\begin{document}','\\maketitle'];
  if(preamble)front.splice(0,1,...preamble);
  if(linkedDoi && !front.some(line=>line.endsWith('{hyperref}')))
    front.splice(front.indexOf('\\begin{document}'),0,'\\usepackage{hyperref}');
  return [...front,...body,'\\end{document}',''].join('\n');
}
export async function typeset(title:string,markdown:string,style:Template,signal:AbortSignal,references?:readonly PaperReference[],preamble?:readonly string[],series:readonly MeasuredSeries[]=[],diagrams:readonly DiagramSource[]=[]) {
  const tex=manuscriptTex(title,markdown,style,references,preamble,series,diagrams);
  const dir=await mkdtemp(join(tmpdir(),'athena-typeset-'));
  const search=(process.env.PATH??'').split(delimiter).filter(isAbsolute);
  if(process.platform==='darwin')search.push('/Library/TeX/texbin','/opt/homebrew/bin','/usr/local/bin');
  const path=search.join(delimiter);
  // Fixed commands, generated literal text, private work directory and a clean kpathsea environment.
  const env={PATH:path,SystemRoot:process.env.SystemRoot,HOME:dir,TMPDIR:dir,TEMP:dir,TMP:dir,
    openin_any:'p',openout_any:'p',shell_escape:'f',TEXMFOUTPUT:dir,TEXMFHOME:join(dir,'texmf'),TZ:'UTC'};
  const options={cwd:dir,env,signal,timeout:30000,maxBuffer:256*1024,windowsHide:true};
  try {
    await writeFile(join(dir,'manuscript.tex'),tex,{flag:'wx',mode:0o600});
    await execute('pdflatex',['-no-shell-escape','-interaction=nonstopmode','-halt-on-error','-file-line-error','manuscript.tex'],options);
    const pdfPath=join(dir,'manuscript.pdf');
    if((await stat(pdfPath)).size>8*1024*1024)throw Error('Compiled PDF exceeds 8 MiB.');
    const pdf=await readFile(pdfPath);
    if(pdf.subarray(0,5).toString()!=='%PDF-')throw Error('LaTeX did not produce a PDF.');
    const pages:Buffer[]=[];
    let previewError:string|undefined;
    try {
      await execute('pdftoppm',['-f','1','-l','16','-scale-to','980','-png','manuscript.pdf','page'],options);
      const files=(await readdir(dir)).filter(f=>/^page-\d+\.png$/.test(f)).sort((a,b)=>a.localeCompare(b,'en',{numeric:true}));
      for(const file of files) {
        if((await stat(join(dir,file))).size>2*1024*1024)throw Error('Page preview exceeds 2 MiB.');
        pages.push(await readFile(join(dir,file)));
      }
    } catch(error){signal.throwIfAborted();previewError='Page preview requires pdftoppm. '+String((error as Error).message).slice(0,300);}
    return {tex:Buffer.from(tex),pdf,pages,previewError};
  } catch(error) {
    signal.throwIfAborted();
    const e=error as {stdout?:string;message:string};
    throw new ManagerError('TYPESET_FAILED',(e.stdout?.trim().slice(-1800)||e.message).replaceAll(dir,'[build directory]'));
  } finally {await rm(dir,{recursive:true,force:true});}
}
