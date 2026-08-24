import { literalEntity } from "../literal.js";

export default literalEntity({key:"image",names:{singular:"Image"},route:{basePath:"images"},table:"Image",identifiers:{brand:"ImageId",shortcode:"IMG-",legacy:null},presentation:{titleField:"filename"},fields:null,filters:{urlKeys:["filename","status","entity","createdAt","updatedAt"]},relations:[],search:{enabled:false},capabilities:{auditable:false,images:false,countable:true,softDelete:true,delete:{mode:"hard",bulk:true},merge:false,mcp:[]},extensions:{countFilter:null,relatednessSignals:null,mcpNames:null}});
