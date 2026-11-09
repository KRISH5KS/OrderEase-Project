import { all, one, run } from './db.js';

const hindiMap = [
  [/\bभैया\b/g,'bhaiya'],[/भाईया/g,'bhaiya'],[/पेटियां|पेटियाँ|पेटी|पेटि/g,'peti'],[/केस/g,'case'],[/बिस्कुट|बिस्किट/g,'biscuit'],[/छोटा|छोटी/g,'chhota'],[/ग्लूकोज/g,'glucose'],[/वाशिंग पाउडर|धोने का पाउडर/g,'washing powder'],[/डिटर्जेंट/g,'detergent'],[/चाय पत्ती|चायपत्ती/g,'chai patti'],[/चाय/g,'chai'],[/एक/g,'1'],[/दो/g,'2'],[/तीन/g,'3'],[/चार/g,'4'],[/पांच|पाँच/g,'5'],[/छह/g,'6'],[/सात/g,'7'],[/आठ/g,'8'],[/नौ/g,'9'],[/दस/g,'10'],[/और/g,',']
];
const normalise = s => { let out=String(s).toLowerCase(); for(const [pattern,replacement] of hindiMap)out=out.replace(pattern,replacement); out=out.replace(/[०-९]/g,d=>'०१२३४५६७८९'.indexOf(d)).replace(/[.,!?]/g,' ').replace(/\s+/g,' ').trim(); return out; };
const unitsAmbiguous = /(\bpeti\b|\bcase\b|\bpacket\b)/i;

export async function extractOrder(text, retailerId) {
  if (process.env.AI_API_KEY) {
    try {
      const base=(process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/,'');
      const products=all('SELECT sku,name,unit FROM products');
      const response=await fetch(`${base}/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${process.env.AI_API_KEY}`},body:JSON.stringify({model:process.env.AI_MODEL || 'gpt-4o-mini',temperature:0,response_format:{type:'json_object'},messages:[{role:'system',content:'Convert a Hindi/Hinglish distributor order into JSON {items:[{original,sku,quantity,unit,confidence,alternatives,needs_clarification}]} using only this catalogue. Never invent a SKU. If product or unit is unclear set needs_clarification true. Quantity is number of cases only when explicit.'},{role:'user',content:`Catalogue: ${JSON.stringify(products)}\nRetailer aliases: ${JSON.stringify(all('SELECT phrase,product_id FROM aliases WHERE retailer_id=?',[retailerId]))}\nOrder: ${text}`} ]})});
      if(!response.ok) throw new Error('AI provider returned an error');
      const data=await response.json(); const parsed=JSON.parse(data.choices?.[0]?.message?.content || '{}');
      return validateAI(parsed, text);
    } catch (e) { console.warn('AI provider unavailable; using transparent local parser:',e.message); }
  }
  return localParse(text, retailerId);
}
function validateAI(data, original) {
  if(!Array.isArray(data.items)) throw new Error('AI response did not contain items');
  const catalogue=all('SELECT sku,name FROM products');
  return {mode:'ai',items:data.items.map(x=>{
    const sku=x.sku||null;
    const supplied=Array.isArray(x.alternatives)?x.alternatives.slice(0,2).map(a=>typeof a==='string'?{sku:a,name:a}:{sku:String(a.sku||''),name:String(a.name||a.sku||'')}):[];
    const alternatives=[...supplied];
    for(const p of catalogue.filter(p=>p.sku!==sku&&!alternatives.some(a=>a.sku===p.sku))){if(alternatives.length===2)break;alternatives.push({sku:p.sku,name:p.name});}
    return {original:String(x.original||original),sku,quantity:Number.isInteger(x.quantity)?x.quantity:null,unit:x.unit||null,confidence:Math.max(0,Math.min(1,Number(x.confidence)||0)),alternatives,needs_clarification:Boolean(x.needs_clarification)||!sku||!Number.isInteger(x.quantity)};
  })};
}
function localParse(input, retailerId) {
  const text=normalise(input); const catalog=all('SELECT * FROM products'); const aliases=all('SELECT phrase,product_id FROM aliases WHERE retailer_id=?',[retailerId]);
  const chunks=text.split(/,|\band\b|\baur\b|(?=\b\d+\s*(?:peti|case|cases|carton)\b)/).map(x=>x.trim()).filter(Boolean);
  const items=[];
  for(const chunk of chunks) {
    const qtyMatch=chunk.match(/\b(\d+)\s*(?:peti|petiya|case|cases|carton)\b/) || chunk.match(/\b(\d+)\b/); const quantity=qtyMatch?Number(qtyMatch[1]):null;
    if(!quantity && !/(biscuit|detergent|washing|tea|chai|glucose|surf)/.test(chunk)) continue;
    let product=null, confidence=0.35;
    const alias=aliases.find(a=>chunk.includes(normalise(a.phrase)));
    if(alias){product=catalog.find(p=>p.id===alias.product_id);confidence=0.96;}
    if(!product){const candidates=[['biscuit',['biscuit','biscuits','glucose']],['detergent',['washing powder','detergent','surf']],['tea',['chai patti','tea leaf','tea','chai']]]; for(const [key,words] of candidates){if(words.some(w=>chunk.includes(w))){product=catalog.find(p=>p.name.toLowerCase().includes(key));confidence=0.88;break;}}}
    const alternatives=product?catalog.filter(p=>p.id!==product.id).slice(0,2).map(p=>({sku:p.sku,name:p.name})):catalog.slice(0,2).map(p=>({sku:p.sku,name:p.name}));
    const unitExplicit=/\b(case|cases|peti|petiya|carton)\b/.test(chunk);
    items.push({original:chunk,sku:product?.sku||null,quantity,unit:unitExplicit?'case':null,confidence,alternatives,needs_clarification:!product||!quantity||!unitExplicit});
  }
  return {mode:'local-parser',items};
}
export function saveAlias(retailerId, phrase, sku) {
  const product=one('SELECT id FROM products WHERE sku=?',[sku]);
  if(!product) throw new Error('Unknown SKU');
  const clean=normalise(phrase).replace(/\b\d+(?:\s*(?:kg|g|gram|kilo|gram|ml|litre))?\b/g,' ').replace(/\b(bhaiya|bhai|peti|petiya|case|cases|carton|wala|wali|please|dena|bhej do)\b/g,' ').replace(/\s+/g,' ').trim().slice(0,100); if(!clean) throw new Error('Alias phrase required');
  run('INSERT OR REPLACE INTO aliases(retailer_id,phrase,product_id) VALUES(?,?,?)',[retailerId,clean,product.id]);
}

export async function extractOrderFromImage(dataUrl, retailerId) {
  if (!process.env.AI_API_KEY) throw new Error('Image AI needs AI_API_KEY. Use the browser OCR fallback or enter the text manually.');
  if (!/^data:image\/(png|jpeg|webp);base64,/.test(dataUrl)) throw new Error('Upload a PNG, JPG or WebP image.');
  const base=(process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/,'');
  const products=all('SELECT sku,name,unit FROM products');
  const response=await fetch(`${base}/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${process.env.AI_API_KEY}`},body:JSON.stringify({model:process.env.AI_VISION_MODEL||process.env.AI_MODEL||'gpt-4o-mini',temperature:0,response_format:{type:'json_object'},messages:[{role:'system',content:'Read this retailer order-list photo. Return JSON {items:[{original,sku,quantity,unit,confidence,alternatives,needs_clarification}]} using only the catalogue. Do not guess illegible words or units. Mark unclear lines for clarification. Quantity must be an integer.'},{role:'user',content:[{type:'text',text:`Catalogue: ${JSON.stringify(products)}\nRetailer aliases: ${JSON.stringify(all('SELECT phrase,product_id FROM aliases WHERE retailer_id=?',[retailerId]))}`},{type:'image_url',image_url:{url:dataUrl,detail:'high'}}]}]})});
  if(!response.ok) throw new Error(`Vision provider error (${response.status}).`);
  const data=await response.json();return validateAI(JSON.parse(data.choices?.[0]?.message?.content||'{}'),'[uploaded order photo]');
}
export async function transcribeOrderAudio(base64, mimeType, filename) {
  if (!process.env.AI_API_KEY) throw new Error('Voice-note upload needs AI_API_KEY. Use the microphone button in Chrome or paste a transcript.');
  const bytes=Buffer.from(base64,'base64'); if(!bytes.length||bytes.length>15*1024*1024) throw new Error('Audio must be between 1 byte and 15 MB.');
  const base=(process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/,'');
  const form=new FormData();form.append('file',new Blob([bytes],{type:mimeType||'audio/webm'}),filename||'voice-note.webm');form.append('model',process.env.AI_TRANSCRIPTION_MODEL||'whisper-1');form.append('language','hi');
  const response=await fetch(`${base}/audio/transcriptions`,{method:'POST',headers:{Authorization:`Bearer ${process.env.AI_API_KEY}`},body:form});
  if(!response.ok) throw new Error(`Speech transcription provider error (${response.status}).`);
  const data=await response.json();if(!data.text?.trim())throw new Error('No speech could be recognized.');return data.text.trim();
}
