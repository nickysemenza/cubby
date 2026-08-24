import { literalEntity } from "../literal.js";

export default literalEntity({key:"usda-food",names:{singular:"USDA Food"},route:{basePath:"usda",detailParam:"id"},table:null,identifiers:{brand:null,shortcode:null,legacy:null},presentation:{titleField:"description"},fields:null,filters:{urlKeys:[]},relations:[],search:{enabled:false},capabilities:{auditable:false,images:false,countable:false,softDelete:false,delete:null,merge:false,mcp:["get","list"]},extensions:{countFilter:null,relatednessSignals:null,mcpNames:{overrides:{list:"search_usda_foods"}}}});
