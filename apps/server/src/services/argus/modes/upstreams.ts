/** Reviewed source references only; no upstream runtime code is copied or installed.
 * Replace an adapter through the typed registry after reviewing its new license/dependencies. */
export const MODE_UPSTREAMS = {
  rea: {
    url: 'https://github.com/morluto/rea',
    revision: '95c8f57aa2eafab4c8d7d43482b33ceefaf96b16',
    license: 'MIT',
    integration: 'Independent evidence/hypothesis/experiment workflow adapter',
  },
  paper2code: {
    url: 'https://github.com/going-doer/Paper2Code',
    revision: 'ba9169978043d5799c8d4f4a0963e6b66a24c2e1',
    license: 'Apache-2.0',
    integration: 'Independent analysis/specification/reproduction workflow adapter',
  },
  eval: {
    url: 'https://github.com/Arize-ai/phoenix',
    revision: 'c9a3087027fedff23c32b083534d0a16bcce1a25',
    license: 'ELv2 (packages/phoenix-evals/LICENSE)',
    integration: 'Independent dataset/rubric/result adapter; no ELv2 package bundled',
  },
} as const;
