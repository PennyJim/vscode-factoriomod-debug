import { WritableStream as WritableMemoryStream } from "memory-streams";


function extend_string(param:{
	pre?:string		// if str is not empty this will be preprended
	str:string		// the part to concat which may be empty ("")
	post?:string	// if str is not empty this will be appended

	//if str is empty this will be used, pre and post will not be applied however
	fallback?:string
}):string {
	if (!param.str) {
		return param.fallback ?? "";
	} else {
		return `${param.pre??""}${param.str}${param.post??""}`;
	}
}

function escape_lua_keyword(str:string) {
	const keywords = ["and", "break", "do", "else", "elseif", "end", "false", "for",
		"function", "goto", "if", "in", "local", "nil", "not", "or", "repeat", "return",
		"then", "true", "until", "while"];
	return keywords.includes(str)?`${str}_`:str;
}

function to_lua_ident(str:string) {
	return escape_lua_keyword(str.replace(/[^a-zA-Z0-9]/g,"_").replace(/^([0-9])/,"_$1"));
}

function sort_by_order(a:{order:number},b:{order:number}) {
	return a.order - b.order;
}

export class ApiDocGenerator {
	private readonly docs:ApiDocs;

	private readonly classes:Map<string,ApiClass>;
	private readonly events:Map<string,ApiEvent>;
	private readonly concepts:Map<string,ApiConcept>;
	private readonly builtins:Map<string,ApiBuiltin>;
	private readonly globals:Map<string,ApiGlobalObject>;
	private readonly table_or_array_types:Map<string,ApiType>;

	private readonly defines:Set<string>;

	//TODO: version
	private runtime_api_base:string = "https://lua-api.factorio.com/latest/";

	constructor(readonly docjson:string) {
		this.docs = JSON.parse(docjson);

		if (this.docs.application !== "factorio" || this.docs.stage !== "runtime") {
			throw "Unknown JSON Format";
		}

		if (this.docs.api_version !== 1) {
			throw `Unsupported JSON Version ${this.docs.api_version}`;
		}

		this.classes = new Map(this.docs.classes.map(c => [c.name,c]));
		this.events = new Map(this.docs.events.map(c => [c.name,c]));
		this.concepts = new Map(this.docs.concepts.map(c => [c.name,c]));
		this.builtins = new Map(this.docs.builtin_types.map(c => [c.name,c]));

		this.table_or_array_types = new Map(
			(<ApiTableOrArrayConcept[]>this.docs.concepts.filter(c=>c.category==="table_or_array")).map(
				ta=>[ta.name,ta.parameters.sort(sort_by_order)[0].type]
			));

		this.globals = new Map(this.docs.global_objects.map(g => [
				this.format_type(g.type,()=>{
						throw "complex global";
					}),
				g
			]));


		this.defines = new Set<string>();
		this.defines.add("defines");
		this.docs.defines.forEach(define=>this.add_define(define,"defines."));
	}

	public generate_emmylua_docs() {
		const ms = new WritableMemoryStream();
		ms.write(`---@meta\n`);
		ms.write(`---@diagnostic disable\n`);
		ms.write(`\n`);
		this.generate_emmylua_builtin(ms);
		ms.write(`\n`);
		this.generate_emmylua_defines(ms);
		ms.write(`\n`);
		this.generate_emmylua_events(ms);
		ms.write(`\n`);
		this.generate_emmylua_classes(ms);
		ms.write(`\n`);
		this.generate_emmylua_concepts(ms);
		ms.write(`\n`);
		this.generate_emmylua_custom(ms);
		ms.write(`\n`);
		this.generate_emmylua_table_types(ms);
		ms.write(`\n`);
		return ms.toBuffer();
	}

	private generate_emmylua_builtin(output:WritableMemoryStream) {
		this.docs.builtin_types.forEach(builtin=>{
			if (!(["string","boolean","table"].includes(builtin.name))) {
				output.write(this.convert_description(
					extend_string({str:builtin.description, post:"\n\n"}) + this.view_documentation(builtin.name)
					));
				output.write(`---@class ${builtin.name}:number\n`);
			}
		});
	}
	private generate_emmylua_defines(output:WritableMemoryStream) {
		output.write(this.convert_description(this.view_documentation("defines")));
		output.write("---@class defines\n");
		output.write("defines={}\n");

		const generate = (define:ApiDefine,name_prefix:string) => {
			const name = `${name_prefix}${define.name}`;
			output.write(this.convert_description(
				extend_string({str: define.description, post: "\n\n"})+this.view_documentation(name)
			));
			output.write(`---@class ${name}\n${name}={\n`);
			const child_prefix = `${name}.`;
			if (define.values) {
				define.values.forEach(value=>{
					output.write(this.convert_description(
						extend_string({str: value.description, post: "\n\n"})+this.view_documentation(`${name}.${value.name}`)
						));
					output.write(to_lua_ident(value.name)+"=0,\n");
					this.defines.add(`${child_prefix}${value.name}`);
				});
			}
			output.write("}\n");
			if (define.subkeys) {
				define.subkeys.forEach(subkey=>generate(subkey,child_prefix));
			}
		};

		this.docs.defines.forEach(define=>generate(define,"defines."));
	}
	private generate_emmylua_events(output:WritableMemoryStream) {
		this.docs.events.forEach(event=>{
			const view_documentation_link = this.view_documentation(event.name);
			output.write(this.convert_description(this.format_entire_description(event,view_documentation_link)));
			output.write(`---@class ${event.name}\n`);
			event.data.forEach(param=>{
				output.write(this.convert_description(extend_string({str: param.description, post: "\n\n"}) + view_documentation_link));
				output.write(`---@field ${param.name} ${this.format_type(param.type,()=>[`${event.name}.${param.name}`, view_documentation_link])}`);
				output.write(param.optional?"|nil\n":"\n");
			});
		});
	}
	private generate_emmylua_classes(output:WritableMemoryStream) {
		this.docs.classes.forEach(aclass=>{
			this.add_class(output,aclass);
		});
	}

	private convert_param_or_return(api_type:ApiType|undefined, description:string|undefined, get_table_name_and_view_doc_link:()=>[string,string]):string
	{
		const formatted_type = this.format_type(api_type,get_table_name_and_view_doc_link);
		if (!description) {
			return `${formatted_type}\n`;
		} else if (!description.includes("\n")) {
			return `${formatted_type}@${this.preprocess_description(description)}\n`;
		} else {
			return `${formatted_type}@\n${this.convert_description(description)}`;
		}
	}

	private add_class(output:WritableMemoryStream,aclass:ApiClass):void;
	private add_class(output:WritableMemoryStream,aclass:ApiStructConcept,is_struct:true):void;
	private add_class(output:WritableMemoryStream,aclass:ApiClass|ApiStructConcept,is_struct?:boolean):void {
		const add_attribute = (attribute:ApiAttribute,oper_lua_name?:string,oper_html_name?:string)=>{
			const aname = oper_lua_name ?? attribute.name;
			const view_doc_link = this.view_documentation(`${aclass.name}::${oper_html_name ?? aname}`);
			output.write(this.convert_description(this.format_entire_description(
				attribute, view_doc_link, `[${attribute.read?"R":""}${attribute.write?"W":""}]${extend_string({pre:"\n", str:attribute.description})}`
			)));
			output.write(`---@field ${aname} ${this.format_type(attribute.type, ()=>[`${aclass.name}.${aname}`,view_doc_link])}\n`);
		};

		const view_documentation_for_method = (method_name:string)=>{
			return this.view_documentation(`${aclass.name}::${method_name}`);
		};

		const add_return_annotation = (method:ApiMethod)=>{
			if (method.return_type) {
				output.write(`---@return ${this.convert_param_or_return(method.return_type,method.return_description,()=>[
					`${aclass.name}.${method.name}_return`, view_documentation_for_method(method.name)
				])}`);
			}
		};

		const convert_description_for_method = (method:ApiMethod,html_name?:string)=>
			this.convert_description(this.format_entire_description(method,view_documentation_for_method(html_name??method.name)));

		const add_regular_method = (method:ApiMethod,oper_lua_name?:string,oper_html_name?:string)=>{
			output.write(convert_description_for_method(method,oper_html_name));
			const sorted_params = method.parameters.sort(sort_by_order);
			sorted_params.forEach(parameter=>{
				output.write(`---@param ${escape_lua_keyword(parameter.name)}${parameter.optional?"?":" "}`);
				output.write(this.convert_param_or_return(parameter.type,parameter.description,()=>[
					`${aclass.name}.${method.name}.${parameter.name}`, view_documentation_for_method(method.name)
				]));
			});
			if (method.variadic_type) {
				output.write(`---@vararg ${this.format_type(method.variadic_type,()=>[`${aclass.name}.${method.name}_vararg`, view_documentation_for_method(method.name)])}\n`);
				if (method.variadic_description) {
					output.write(this.convert_description(`\n**vararg**: ${method.variadic_description.includes("\n")?"\n\n":""}${method.variadic_description}`));
				}
			}
			add_return_annotation(method);

			output.write(`${oper_lua_name??method.name}=function(${sorted_params.map(p=>escape_lua_keyword(p.name)).concat(method.variadic_type?["..."]:[]).join(",")})end,\n`);
		};

		const add_method_taking_table = (method:ApiMethod)=>{
			const param_class_name = `${aclass.name}.${method.name}_param`;
			this.add_table_type(output,method,param_class_name,this.view_documentation(`${aclass.name}::${method.name}`));
			output.write("\n");
			output.write(convert_description_for_method(method));
			output.write(`---@param param${method.table_is_optional?"?":" "}${param_class_name}\n`);
			add_return_annotation(method);
			output.write(`${method.name}=function(param)end,\n`);
		};

		const add_method = (method:ApiMethod)=> method.takes_table?add_method_taking_table(method):add_regular_method(method);

		const needs_label = !!aclass.description || !!aclass.notes;
		output.write(this.convert_description(this.format_entire_description(
			aclass, this.view_documentation(aclass.name),
			extend_string({
				pre: "**Global Description:**\n",
				str: this.globals.get(aclass.name)?.description ?? "",
				post: (needs_label?"\n\n**Class Description:**\n":"\n\n")+aclass.description,
				fallback: aclass.description,
			})
		)));
		if (is_struct) {
			output.write(`---@class ${aclass.name}\n`);
		} else {
			const base_classes = (<ApiClass>aclass).base_classes;
			output.write(`---@class ${aclass.name}${base_classes?":"+base_classes.join(","):""}\n`);
			if((<ApiClass>aclass).operators.find((operator:ApiOperator)=>!["index","length","call"].includes(operator.name))){
					throw "Unkown operator";
			}
		}

		aclass.attributes.forEach(a=>add_attribute(a));

		if (!is_struct) {
			((<ApiClass>aclass).operators.filter(op=>["index","length"].includes(op.name)) as ApiAttribute[]).forEach((operator)=>{
				const lua_name = operator.name === "index" ? "__index" : "__len";
				const html_name = `operator%20${ operator.name === "index" ? "[]" : "#"}`;
				add_attribute(operator,lua_name,html_name);
			});

			output.write(`${this.globals.get(aclass.name)?.name ?? `local ${to_lua_ident(aclass.name)}`}={\n`);
			(<ApiClass>aclass).methods.forEach(add_method);

			const callop = (<ApiClass>aclass).operators.find(op=>op.name==="call") as ApiMethod;
			if (callop){
				add_regular_method(callop, "__call", "operator%20()");
			}
			output.write("}\n");
		}

	}

	private generate_emmylua_concepts(output:WritableMemoryStream) {
		const add_identification = (identification:ApiIdentificationConcept)=>{
			const view_documentation_link = this.view_documentation(identification.name);
			const sorted_options = identification.options.sort(sort_by_order);
			const get_table_name_and_view_doc_link = (option:ApiIdentificationConcept["options"][0]):[string,string]=>{
				return [`${identification.name}.${option.order}`, view_documentation_link];
			};
			output.write(this.convert_description(this.format_entire_description(
				identification, view_documentation_link,
				`${extend_string({str:identification.description, post:"\n\n"})
				}May be specified in one of the following ways:${
					sorted_options.map(option=>`\n- ${
						this.format_type(option.type, ()=>get_table_name_and_view_doc_link(option), true)
					}${extend_string({pre:": ",str:option.description})}`)
				}`
			)));
			output.write(`---@class ${identification.name}:`);
			output.write(sorted_options.map(option=>this.format_type(option.type, ()=>get_table_name_and_view_doc_link(option))).join(","));
			output.write("\n");
		};

		const add_concept = (concept:ApiConceptConcept)=>{
			output.write(this.convert_description(this.format_entire_description(concept,this.view_documentation(concept.name))));
			output.write(`---@class ${concept.name}\n`);
		};

		const add_struct = (struct:ApiStructConcept)=>{
			this.add_class(output, struct,true);
		};

		const add_flag = (flag:ApiFlagConcept)=>{
			const view_documentation_link = this.view_documentation(flag.name);
			output.write(this.convert_description(this.format_entire_description(flag,view_documentation_link)));
			output.write(`---@class ${flag.name}\n`);
			flag.options.forEach(option=>{
				output.write(this.convert_description(
					extend_string({str:option.description, post:"\n\n"})+
					view_documentation_link
					));
				output.write(`---@field ${option.name} boolean|nil\n`);
			});
		};

		const add_table_concept = (table_concept:ApiTableConcept)=>{
			this.add_table_type(output, table_concept, table_concept.name, this.view_documentation(table_concept.name));
		};

		const add_table_or_array_concept = (ta_concept:ApiTableOrArrayConcept)=>{
			this.add_table_type(output, ta_concept, ta_concept.name, this.view_documentation(ta_concept.name));
		};

		const add_union = (union:ApiUnionConcept)=>{
			output.write(this.convert_description(this.format_entire_description(
				union, this.view_documentation(union.name),[
					union.description, "Possible values are:",
					...union.options.sort(sort_by_order).map(option=>
						`\n- "${option.name}"${extend_string({pre:" - ",str:option.description})}`)
				].filter(s=>!!s).join("")
			)));
			output.write(`---@class ${union.name}\n`);
		};

		const add_filter = (filter:ApiFilterConcept)=>{
			this.add_table_type(output,filter,filter.name,this.view_documentation(filter.name), "Applies to filter");
		};

		this.docs.concepts.forEach(concept=>{
			switch (concept.category) {
				case "identification":
					return add_identification(concept);
				case "concept":
					return add_concept(concept);
				case "struct":
					return add_struct(concept);
				case "flag":
					return add_flag(concept);
				case "table":
					return add_table_concept(concept);
				case "table_or_array":
					return add_table_or_array_concept(concept);
				case "union":
					return add_union(concept);
				case "filter":
					return add_filter(concept);
				default:
					throw `Unknown concept category: ${concept}`;
			}
		});
	}
	private generate_emmylua_custom(output:WritableMemoryStream) {
		//TODO: just copy custom.lua
	}
	private generate_emmylua_table_types(output:WritableMemoryStream) {
		output.write(this.tablebuff.toBuffer());
	}


	private add_define(define:ApiDefine,name_prefix:string):void {
		const name = `${name_prefix}${define.name}`;
		this.defines.add(name);
		const child_prefix = `${name}.`;
		if (define.values) {
			define.values.forEach(value=>{
				this.defines.add(`${child_prefix}${value.name}`);
			});
		}
		if (define.subkeys) {
			define.subkeys.forEach(subkey=>this.add_define(subkey,child_prefix));
		}
	}

	private readonly complex_table_type_name_lut = new Set<string>();
	private tablebuff = new WritableMemoryStream();

	private add_table_type(output:WritableMemoryStream, type_data:ApiWithParameters, table_class_name:string, view_documentation_link:string, applies_to:string = "Applies to"): string
	{

		output.write(this.convert_description(view_documentation_link));
		output.write(`---@class ${table_class_name}\n`);

		interface parameter_info{
			readonly name:string
			readonly type:ApiType
			description:string
			readonly optional?:boolean
		}
		const custom_parameter_map = new Map<string, parameter_info>();
		const custom_parameters:parameter_info[] = [];

		type_data.parameters.sort(sort_by_order).forEach((parameter,i)=>{
			const name = parameter.name;
			const custom_parameter = {name:name, type:parameter.type, description:parameter.description, optional:parameter.optional};
			custom_parameter_map.set(name, custom_parameter);
			custom_parameters.push(custom_parameter);
		});

		if (type_data.variant_parameter_groups)
		{
			type_data.variant_parameter_groups.sort(sort_by_order).forEach(group=>{
				group.parameters.sort(sort_by_order).forEach(parameter => {
					let custom_description = `${applies_to} **"${group.name}"**: ${parameter.optional?"(optional)":"(required)"}${extend_string({pre:"\n", str:parameter.description})}`;

					let custom_parameter = custom_parameter_map.get(parameter.name);
					if (custom_parameter)
					{
						custom_parameter.description = extend_string({
						str: custom_parameter.description, post: "\n\n"
						})+custom_description;
					} else {
						custom_parameter = {name:parameter.name, type:parameter.type, description:custom_description, optional:parameter.optional};
						custom_parameter_map.set(parameter.name, custom_parameter);
						custom_parameters.push(custom_parameter);
					}
				});
			});
		}

		custom_parameters.forEach(custom_parameter=>{
			output.write(this.convert_description(extend_string({str: custom_parameter.description, post: "\n\n"})+view_documentation_link));
			output.write(`---@field ${custom_parameter.name} ${this.format_type(custom_parameter.type, ()=>
				[`${table_class_name}.${custom_parameter.name}`, view_documentation_link])}`);
			output.write((custom_parameter.optional? "|nil\n":"\n"));
		});

		return table_class_name;
	}

	private resolve_internal_reference(reference:string, display_name?:string):string
	{
		let relative_link:string;
		if (this.builtins.has(reference)) {
			relative_link = "Builtin-Types.html#"+reference;
		} else if (this.classes.has(reference)) {
			relative_link = reference+".html";
		} else if (this.events.has(reference)) {
			relative_link = "events.html#"+reference;
		} else if (this.defines.has(reference)) {
			relative_link = "defines.html#"+reference;
		} else {
			const matches = reference.match(/^(.*?)::(.*)$/);
			if (!!matches) {
				const class_name = matches![1];
				const member_name = matches![2];
				const build_link = (main:string)=> `${main}.html#${class_name}.${member_name}`;
				if (this.classes.has(class_name)) {
					relative_link = build_link(class_name);
				} else if (this.concepts.has(class_name)) {
					relative_link = build_link("Concepts");
				} else {
					throw "unresolved reference";
				}
			} else if (reference.match(/Filters$/)) {
				if (reference.match(/^Lua/)) {
					relative_link = "Event-Filters.html#"+reference;
				} else if (this.concepts.has(reference)) { // the other types of filters are just concepts
					relative_link = "Concepts.html#"+reference;
				} else {
					throw "unresolved reference";
				}
			} else if (this.concepts.has(reference)) {
				relative_link = "Concepts.html#"+reference;
			} else {
				throw "unresolved reference";
			}
		}
		return `[${display_name??reference}](${this.runtime_api_base}${relative_link})`;
	}

	private resolve_all_links(str:string):string {
		return str.replace(/\[(.+?)\]\((.+?)\)/g,(match,display_name,link)=>{
			if (link.match(/^http(s?):\/\//)) {
				return `[${display_name??link}](${link})`;
			} else if (link.match(/\.html($|#)/)) {
				return `[${display_name??link}](${this.runtime_api_base}${link})`;
			} else {
				return this.resolve_internal_reference(link,display_name);
			}
		});
	}

	private view_documentation(reference:string):string {
		return this.resolve_internal_reference(reference, "View documentation");
	}

	private preprocess_description(description:string):string {
		const escape_single_newline = (str:string) => {
			return this.resolve_all_links(str.replace(/([^\n])\n([^\n])/g,"$1  \n$2"));
		};

		let result = new WritableMemoryStream();

		for (const match of description.matchAll(/((?:(?!```).)*)($|```(?:(?!```).)*```)/gs)) {
			result.write(escape_single_newline(match[1]));
			if (match[2]) {
				result.write(match[2]);
			}
		}
		return result.toString();
	}

	private convert_description(description:string):string {
		if (!description) {
			return "";
		}
		return `---${this.preprocess_description(description).replace(/\n/g,"\n---")}\n`;
	}

	private format_type(api_type:ApiType|undefined,get_table_name_and_view_doc_link:()=>[string,string], add_doc_links?: boolean):string
	{
		const wrap = add_doc_links ? (x:string)=>this.resolve_internal_reference(x) : (x:string)=>x;

		const modify_getter = (table_name_appended_str:string) => ():[string,string] => {
			const [table_class_name, view_documentation_link] = get_table_name_and_view_doc_link();
			return [table_class_name+table_name_appended_str, view_documentation_link];
		};

		if (!api_type) { return "any"; }
		if (typeof api_type === "string") {
			const elem_type = this.table_or_array_types.get(api_type);
			if (elem_type)
			{
				// use format_type just in case it's a complex type or another `table_or_array`
				const value_type = this.format_type(elem_type,()=>[api_type+"_elem",this.view_documentation(api_type)]);
				return `${wrap(api_type)}<${wrap("int")},${value_type}>`;
				// this makes sumneko.lua think it's both the `api_type` and
				// `table<int,value_type>` where `value_type` is the type of the first
				// "parameter" (field) for the `table_or_array` concept
				// it's hacks all the way
			}
			return wrap(api_type);
		}

		switch (api_type.complex_type) {
			case "array":
				return this.format_type(api_type.value, get_table_name_and_view_doc_link)+"[]";
			case "dictionary":
				return `${wrap("table")}<${this.format_type(api_type.key, modify_getter("_key"))},${this.format_type(api_type.value, modify_getter("_value"))}>`;
			case "variant":
				return api_type.options.map((o,i)=> this.format_type(o,modify_getter("."+i))).join("|");
			case "LuaLazyLoadedValue":
				return `${wrap("LuaLazyLoadedValue")}<${this.format_type(api_type.value, get_table_name_and_view_doc_link)},nil>`;
			case "LuaCustomTable":
				return `${wrap("LuaCustomTable")}<${this.format_type(api_type.key, modify_getter("_key"))},${this.format_type(api_type.value, modify_getter("_value"))}>`;
			case "table":
				const [table_class_name, view_documentation_link] = get_table_name_and_view_doc_link();

				if (this.complex_table_type_name_lut.has(table_class_name)) {return table_class_name;}

				this.complex_table_type_name_lut.add(table_class_name);
				return this.add_table_type(this.tablebuff,api_type, table_class_name, view_documentation_link);
			case "function":
				return `fun(${api_type.parameters.map((p,i)=>`param${i+1}:${this.format_type(p,modify_getter(`_param${i+1}`))}`).join(",")})`;
		}
	}

	private format_entire_description(obj:ApiWithNotes&{description:string; subclasses?:string[]}, view_documentation_link:string, description?:string)
	{
		return [
			description??obj.description,
			obj.notes?.map(note=>`**Note:** ${note}`)?.join("\n\n"),
			view_documentation_link,
			obj.examples?.map(example=>`### Example\n${example}`)?.join("\n\n"),
			obj.subclasses && (
				`_Can only be used if this is ${
					obj.subclasses.length === 1 ? obj.subclasses[0] :
					`${obj.subclasses.slice(0,-1).join(", ")} or ${obj.subclasses[obj.subclasses.length-1]}`
				}_`
			),
			obj.see_also && `### See also\n${obj.see_also.map(sa=>`- ${this.resolve_internal_reference(sa)}`).join("\n")}`,
			].filter(s=>!!s).join("\n\n");
	}
}