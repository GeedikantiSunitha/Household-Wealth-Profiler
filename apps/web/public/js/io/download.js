/* Saving a file to the adviser's device: through the Claude artifact viewer's downloads capability when it is there, else a normal browser download. */
import { toast } from '../lib/dom.js';

// The artifact viewer's downloads capability, when the page runs inside one (set by initDownloads)
let DL=null;
// Called once at start-up, before anything can be saved
export function initDownloads(){try{if(window.claude&&window.claude.use)window.claude.use('downloads').then(d=>{DL=d},()=>{})}catch(e){DL=null}}
export async function save(filename,data){
  const blob=data instanceof Blob?data:new Blob([data]);
  if(DL){try{await DL.save({filename,data:blob});toast('Saved '+filename)}catch(err){if(err&&err.code!=='declined')toast(err&&err.code==='rate_limited'?'A save is already waiting for your confirmation':'Could not save the file')}return}
  const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),4000);toast('Downloaded '+filename);
}
