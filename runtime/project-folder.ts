import { execFileSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { ManagerError } from './orchestration.ts';
import { isAbsolute, relative, sep } from 'node:path';

export function projectFolder(input:string, storage:string) {
  if(!isAbsolute(input))throw new ManagerError('PROJECT_FOLDER_UNAVAILABLE','Enter the absolute path to the local project folder.');
  let path:string;
  try{path=realpathSync(input);}catch{throw new ManagerError('PROJECT_FOLDER_UNAVAILABLE','Athena could not find or access that folder. Check the path and its permissions.');}
  const internal=realpathSync(storage);
  const inside=(a:string,b:string)=>{const r=relative(a,b);return !r||(!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep));};
  if(!statSync(path).isDirectory()||inside(internal,path)||inside(path,internal))throw new ManagerError('PROJECT_FOLDER_UNAVAILABLE','Choose a directory separate from Athena storage.');
  try {
    const git=(...args:string[])=>execFileSync('git',['--no-optional-locks','-C',path,...args],{encoding:'utf8',timeout:2000,maxBuffer:8192,stdio:['ignore','pipe','pipe']}).trim();
    if(git('rev-parse','--is-inside-work-tree')!=='true')return {path};
    let branch:string;
    try{branch=git('symbolic-ref','--short','HEAD');}catch{branch=git('rev-parse','--short','HEAD')+' (detached)';}
    return {path,branch};
  }catch{return {path};}
}

export async function chooseProjectFolder() {
  const {execFile}=await import('node:child_process');
  const {promisify}=await import('node:util');
  const command=process.platform==='darwin'?['/usr/bin/osascript','-e','POSIX path of (choose folder with prompt "Choose an Athena project folder")']:
    process.platform==='win32'?['powershell.exe','-NoProfile','-STA','-Command','Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; if($d.ShowDialog() -eq "OK"){$d.SelectedPath}']:null;
  if(!command)throw new ManagerError('PROJECT_FOLDER_UNAVAILABLE','Enter the path of a folder on the Athena host.');
  try{
    const {stdout}=await promisify(execFile)(command[0]!,command.slice(1),{timeout:120000,maxBuffer:8192});
    return stdout.trim();
  }catch(err){
    if(String((err as Error).message).includes('(-128)'))return '';
    throw new ManagerError('PROJECT_FOLDER_UNAVAILABLE','The system folder picker could not open. Enter the absolute local path.');
  }
}
