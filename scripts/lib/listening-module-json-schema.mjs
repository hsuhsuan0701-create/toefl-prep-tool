/**
 * Gemini generateContent structured JSON schema for one ORIGINAL Listening module.
 * The server's Zod schema remains the final authority; this only reduces malformed
 * responses from the model, never bypasses checks or changes the published schema.
 * No API usage occurs in this module.
 * Empty-string enum is deliberately omitted: some Google structured-output
 * validation backends reject enum values of "", with HTTP 400. The prompt
 * says audio="", and ORIGINAL Zod/renderer checks are still authoritative.
 */
const str={type:"string"};
const id={type:"string",description:"Unique ASCII identifier, letters/numbers/-/_ only, <=64 characters"};
const option={type:"object",properties:{id:{type:"string",enum:["A","B","C","D"]},text:str},
 required:["id","text"],additionalProperties:false};
const speaker={type:"object",properties:{
 id,role:str,gender:{type:"string",enum:["male","female"]},
 accent:{type:"string",enum:["north-american"]},
 voice:{type:"string",enum:["Puck"]},
 provider:{type:"string",enum:["gemini"]},
},required:["id","role","gender","accent","voice","provider"],additionalProperties:false};
const question={type:"object",properties:{
 id,stem:str,skill:{type:"string",enum:["gist","detail","inference","function","attitude"]},
 options:{type:"array",minItems:4,maxItems:4,items:option},
 correctOptionId:{type:"string",enum:["A","B","C","D"]},explanationZh:str,
},required:["id","stem","skill","options","correctOptionId","explanationZh"],additionalProperties:false};
function obj(properties,required=Object.keys(properties)){
 return {type:"object",properties,required,additionalProperties:false};
}
function sized(items,n){return {type:"array",minItems:n,maxItems:n,items};}
const lcr=obj({id,taskType:{type:"string",enum:["listen_choose"]},audio:{type:"string",description:"MUST be exactly the empty string; audio is filled by renderer later"},
 speaker,utterance:str,options:sized(option,4),
 correctOptionId:{type:"string",enum:["A","B","C","D"]},
 skill:{type:"string",enum:["gist","detail","inference","function","attitude"]},explanationZh:str});
const conversation=obj({id,taskType:{type:"string",enum:["conversation"]},
 audio:{type:"string",description:"MUST be exactly the empty string; audio is filled by renderer later"},setting:str,speakers:sized(speaker,2),
 transcript:{type:"array",minItems:6,items:obj({speakerId:id,text:str})},
 questions:sized(question,2)});
const announcement=obj({id,taskType:{type:"string",enum:["announcement"]},
 audio:{type:"string",description:"MUST be exactly the empty string; audio is filled by renderer later"},setting:str,speaker,transcript:str,
 questions:sized(question,2)});
const academicTalk=obj({id,taskType:{type:"string",enum:["academic_talk"]},
 audio:{type:"string",description:"MUST be exactly the empty string; audio is filled by renderer later"},discipline:str,speaker,transcript:str,
 questions:sized(question,4)});
export function listeningModuleJsonSchema(counts,timeLimitSec){
 return obj({
  timeLimitSec:{type:"integer",minimum:timeLimitSec,maximum:timeLimitSec},
  listenChoose:sized(lcr,counts.listenChoose),
  conversations:sized(conversation,counts.conversations),
  announcements:sized(announcement,counts.announcements),
  academicTalks:sized(academicTalk,counts.academicTalks),
 });
}
/** Count only error code and structural path; never echo answer-bearing content. */
export function structuralIssues(issues,max=24){
 return issues.slice(0,max).map(e=>({
  path:Array.isArray(e.path)?e.path.map(String).join("."):"?",
  code:String(e.code??"unknown"),
  ...(typeof e.expected==="string"?{expected:e.expected}:{}),
 }));
}
