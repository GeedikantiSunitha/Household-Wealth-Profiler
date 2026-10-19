/* The one setting the page reads at run time: the address of the back end, when it is not the page's
   own (the split-address mode). Empty, as here, means one address: calls go to api/ on the page's own
   address, where the web tier passes them to the back end. The web tier's container replaces this file
   from its API_BASE_URL setting (frontend/nginx.conf.template); nothing secret is ever put in it. */
window.HWP_API_BASE = '';
