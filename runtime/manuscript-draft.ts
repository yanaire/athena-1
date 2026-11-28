import { parseStreamingJson } from '@earendil-works/pi-ai';
import { object } from './orchestration.ts';

export type ManuscriptDraft = {attemptId:string;updatedAt:number;role:'writer'|'editor';text:string};
export type SectionBrief = {heading:string;purpose:string;sources:{sourceId:string;version:string}[];visual:string};

export function sectionBriefs(input:unknown,outline:readonly string[],sources:readonly {sourceId:string;version:string}[]):SectionBrief[] {
  if (!Array.isArray(input)||input.length!==outline.length) throw Error('Supply a brief for every outline heading.');
  return input.map((row,i)=>{
    if (!object(row)||row.heading!==outline[i]||typeof row.purpose!=='string'||!row.purpose.trim()||row.purpose.length>640
      ||!Array.isArray(row.sources)||row.sources.length>8||new Set(row.sources).size!==row.sources.length
      ||typeof row.visual!=='string'||row.visual.length>400) throw Error('Invalid section brief at heading '+outline[i]);
    const refs=row.sources.map((index:unknown)=>{
      if(typeof index!=='number'||!Number.isSafeInteger(index)||index<1||index>sources.length)throw Error('Choose a numbered source in the manuscript evidence.');
      const {sourceId,version}=sources[index-1]!;return {sourceId,version};
    });
    return {heading:String(row.heading),purpose:row.purpose.trim(),sources:refs,visual:row.visual.trim()};
  });
}

const jsonFence = /^```(?:json)?[ \t]*\r?\n/i;

export function parseManuscriptJson(message:string|null):unknown {
  let text=(message??'').trim();
  if(jsonFence.test(text) && /\r?\n```$/.test(text))
    text=text.replace(jsonFence,'').replace(/\r?\n```$/,'');
  try { return JSON.parse(text); }
  catch { throw Error('Return the complete manuscript stage as one valid JSON array.'); }
}

// Accept only the public manuscript fields in an assigned writer/editor message.
// Reasoning, file contents, tool results and other tool calls never become a draft.
export function streamedManuscript(role:'writer'|'editor',message:unknown,outline:readonly string[]):string|undefined {
  if (!object(message)||message.role!=='assistant'||!Array.isArray(message.content))return;
  if(role==='editor'){
    const call=message.content.find(p=>object(p)&&p.type==='toolCall'&&p.name==='publish_manuscript');
    if(object(call)&&object(call.arguments)&&typeof call.arguments.text==='string')
      return call.arguments.text.slice(0,120000)||undefined;
    return;
  }
  const text=message.content.filter(p=>object(p)&&p.type==='text'&&typeof p.text==='string').map(p=>p.text).join('').trimStart().replace(jsonFence,'');
  if (!text.trimStart().startsWith('[')||text.length>130000)return;
  const parsed=parseStreamingJson<unknown>(text);
  if(!Array.isArray(parsed))return;
  const sections=[];
  for(const [i,part] of parsed.slice(0,outline.length).entries()){
    if(!object(part)||part.heading!==outline[i]||typeof part.text!=='string')break;
    sections.push('## '+outline[i]+'\n'+part.text.slice(0,20000));
  }
  return sections.join('\n\n').slice(0,120000)||undefined;
}
