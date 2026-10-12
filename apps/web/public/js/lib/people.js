/* People in the open household: names and whether they are adults (from the rules in core.js). */
import { state } from '../state.js';

export const memberName=r=>state.E.memberName(r);
export const isAdult=m=>state.E.isAdult(m);
