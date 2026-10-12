/* Saving a file to the adviser's device: a normal browser download. */
import { toast } from '../lib/dom.js';

export async function save(filename,data){
  const blob=data instanceof Blob?data:new Blob([data]);
  const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),4000);toast('Downloaded '+filename);
}
