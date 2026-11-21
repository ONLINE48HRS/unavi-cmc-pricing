// Contract security from CMC's /v1/dex/security/detail, sorted into the classes the engine acts on. No risk score is made.
//   not-checked     no record: never treated as safe; the position is not assessed
//   cannot-sell     honeypot reported: proceeds are zero, with the evidence
//   tax-unverified  a sell tax is reported but CMC does not document its unit, so it cannot be applied; not assessed
//                   unless the caller supplies a verified rate
//   warning         other reported risks (blacklist, anti-whale, ...): proceeds kept, risks shown
//   no-warnings     nothing reported; fields CMC marks "Unknown" are still listed as not checked
export type SecurityClass='not-checked'|'cannot-sell'|'tax-unverified'|'warning'|'no-warnings';
export type Security={class:SecurityClass;sellTax:string|null;hits:{code:string;level:string|null}[];unknown:string[];source:string|null};

// verifiedSellTax is a fraction (0.05 = 5%) from a source the caller trusts, such as the token contract itself.
export function classifySecurity(detail:any|null,{verifiedSellTax}:{verifiedSellTax?:string}={}):Security{
 if(!detail)return {class:'not-checked',sellTax:null,hits:[],unknown:[],source:null};
 const display={...(detail.evmDisplay??{}),...(detail.solanaDisplay??{})},source=detail.extra?.source??null;
 const unknown=Object.entries(display).filter(([,v])=>v==='Unknown').map(([k])=>k.replace(/Status$/,''));
 const hits=((detail.securityItems??[]) as any[]).filter(i=>i?.isHit===true).map(i=>({code:String(i.riskCode??i.code),level:i.riskyLevel??null}));
 if(display.honeypotStatus==='Yes')return {class:'cannot-sell',sellTax:null,hits,unknown,source};
 if(verifiedSellTax!==undefined){const t=Number(verifiedSellTax);if(!(t>=0&&t<1))throw RangeError('A verified sell tax is a fraction from 0 to below 1');return {class:hits.length?'warning':'no-warnings',sellTax:verifiedSellTax,hits,unknown,source}}
 const reported=detail.extra?.sellTax;
 if(reported===undefined||reported===null||reported===''||Number(reported)!==0)return {class:'tax-unverified',sellTax:null,hits,unknown:reported===undefined||reported===null||reported===''?[...unknown,'sellTax']:unknown,source};
 return {class:hits.length?'warning':'no-warnings',sellTax:'0',hits,unknown,source};
}
