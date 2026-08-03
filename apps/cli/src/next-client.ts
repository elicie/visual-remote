/// <reference lib="dom" />

const clientPath = "/_visual/client.js";

if (
  document.querySelector(`script[src="${clientPath}"]`) === null
  && document.querySelector("script[data-visual-remote-client]") === null
) {
  const script = document.createElement("script");
  script.type = "module";
  script.src = clientPath;
  script.dataset.visualRemoteClient = "";
  const nonceSource = document.querySelector<HTMLScriptElement>("script[nonce]");
  if (nonceSource?.nonce) script.nonce = nonceSource.nonce;
  document.head.append(script);
}
