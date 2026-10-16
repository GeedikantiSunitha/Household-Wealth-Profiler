/* Shared state of the interface: one object every screen module reads and changes.
     state.S       the open household's data (what is saved)
     state.E       the rules bound to it (window.HWP.bind(state.S)): compute, onboarding, reviews, ...
     state.VIEW    the screen on show ('household', 'kyc', 'bs', 'clients', ...)
     state.BSVIEW  whose balance sheet is on show ('HH' = the household, or a member's ref)
     state.OPEN    which cards are expanded ('members:0', ...)
     state.banner  the message above the form, or null
     state.SCEN_SEL  the life-event scenario on show ('' = none chosen)
     state.LOA_IDX   which letter of authority is on show (index into the household's letters)
   Kept in one object because a module cannot reassign a variable it imports. */
export const state = {
  S: undefined,
  E: undefined,
  VIEW: 'household',
  BSVIEW: 'HH',
  OPEN: new Set(['members:0', 'income:0', 'accounts:0']),
  banner: null,
  SCEN_SEL: '',
  LOA_IDX: 0,
};

// Switch to another household's data and bind the rules to it
export function setState(ns) {
  state.S = ns;
  state.E = window.HWP.bind(state.S);
}
