/**
 * Gemini generateContent structured JSON schema for ONE ORIGINAL Listening module.
 *
 * COMPATIBILITY CONTRACT:
 * Gemini's constrained decoder can reject deeply nested minItems/maxItems and
 * minimum/maximum values with HTTP 400 (even if these are valid JSON Schema).
 * Do not send those constraints in this GENERATION hint. The untouched ORIGINAL
 * Zod schema checks exact counts, time limits and every Item BEFORE a draft is
 * saved, uploaded, or allowed to reach TTS. This module does NOT weaken Zod.
 *
 * Empty-string enum is also omitted: some Google schema backends reject it.
 * Audio must be "" by prompt and is separately validated by original Zod.
 * This file contains no API calls or unpublished question content.
 */
const str={type:"string"};
const id={type:"string",description:"Unique ASCII identifier, letters/numbers/-/_ only, <=64 characters"};
const option={type:"object",properties:{
 id:{type:"string",enum:["A","B","C","D"]},text:str,
},required:["id","text"],additionalProperties:false};
const speaker={type:"object",properties:{
 id,role:str,gender:{type:"string",enum:["male","female"]},
 accent:{type:"string",enum:["north-american"]},
 voice:{type:"string",enum:["Puck"]},
 provider:{type:"string",enum:["gemini"]},
},required:["id","role","gender","accent","voice","provider"],additionalProperties:false};
function obj(properties,required=Object.keys(properties)){
 return {type:"object",properties,required,additionalProperties:false};
}
// In particular, do not put maxItems on deeply nested question/options arrays.
// The LOCAL ORIGINAL schema still enforces exact counts and transcript turns.
function array(items){return {type:"array",items};}
const question=obj({
 id,stem:str,skill:{type:"string",enum:["gist","detail","inference","function","attitude"]},
 options:array(option),correctOptionId:{type:"string",enum:["A","B","C","D"]},
 explanationZh:str,
});
const audio={type:"string",description:"Must be exactly empty string; original local validator checks it"};
const lcr=obj({
 id,taskType:{type:"string",enum:["listen_choose"]},audio,
 speaker,utterance:str,options:array(option),
 correctOptionId:{type:"string",enum:["A","B","C","D"]},
 skill:{type:"string",enum:["gist","detail","inference","function","attitude"]},
 explanationZh:str,
});
const conversation=obj({
 id,taskType:{type:"string",enum:["conversation"]},audio,
 setting:str,speakers:array(speaker),
 transcript:array(obj({speakerId:id,text:str})),questions:array(question),
});
const announcement=obj({
 id,taskType:{type:"string",enum:["announcement"]},audio,
 setting:str,speaker,transcript:str,questions:array(question),
});
const academicTalk=obj({
 id,taskType:{type:"string",enum:["academic_talk"]},audio,
 discipline:str,speaker,transcript:str,questions:array(question),
});
export function listeningModuleJsonSchema(counts,timeLimitSec){
 // Validate our PROMPT contract locally but don't pass the constraints to Google.
 for(const value of [counts.listenChoose,counts.conversations,counts.announcements,counts.academicTalks,timeLimitSec]){
  if(!Number.isSafeInteger(value)||value<0)throw Error("Invalid Listening module composition");
 }
 return obj({
  timeLimitSec:{type:"integer"},
  listenChoose:array(lcr),
  conversations:array(conversation),
  announcements:array(announcement),
  academicTalks:array(academicTalk),
 });
}
/** Local-only diagnostic: inspect schema *shape*, not user content or credentials. */
export function listeningSchemaSummary(schema){
 const stats={arrays:0,boundedArrays:0,numericBounds:0,emptyEnums:0};
 function visit(node){
  if(!node||typeof node!=="object")return;
  if(node.type==="array"){
   stats.arrays++;
   if("minItems" in node||"maxItems" in node)stats.boundedArrays++;
  }
  if("minimum" in node||"maximum" in node)stats.numericBounds++;
  if(Array.isArray(node.enum)&&node.enum.includes(""))stats.emptyEnums++;
  if(node.items)visit(node.items);
  if(node.properties)for(const value of Object.values(node.properties))visit(value);
 }
 visit(schema);
 return {...stats,schemaBytes:Buffer.byteLength(JSON.stringify(schema),"utf8")};
}
/** Count only error code and structural path; never echo answer-bearing content. */
export function structuralIssues(issues,max=24){
 return issues.slice(0,max).map(e=>({
  path:Array.isArray(e.path)?e.path.map(String).join("."):"?",
  code:String(e.code??"unknown"),
  ...(typeof e.expected==="string"?{expected:e.expected}:{}),
 }));
}
