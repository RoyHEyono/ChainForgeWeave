import MarkdownIt from "markdown-it";
import axios from "axios";
import JSZip from "jszip";
import { v4 as uuid } from "uuid";
import {
  Dict,
  LLMResponseError,
  RawLLMResponseObject,
  LLMResponse,
  ChatHistoryInfo,
  isEqualChatHistory,
  PromptVarsDict,
  QueryProgress,
  EvaluationScore,
  LLMSpec,
  EvaluatedResponsesResults,
  CustomLLMProviderSpec,
  LLMResponseData,
  PromptVarType,
  StringOrHash,
  ChatHistory,
  JSONCompatible,
} from "./typing";
import { LLM, LLMProvider, getEnumName, getProvider } from "./models";
import {
  APP_IS_RUNNING_LOCALLY,
  set_api_keys,
  FLASK_BASE_URL,
  call_flask_backend,
  extractSettingsVars,
  areEqualVarsDicts,
  repairCachedResponses,
  deepcopy,
  llmResponseDataToString,
  extendArray,
  extendArrayDict,
  stripWrappingQuotes,
  extractMediaVars,
} from "./utils";
import StorageCache, { MediaLookup, StringLookup } from "./cache";
import { PromptPipeline } from "./query";
import {
  PromptPermutationGenerator,
  PromptTemplate,
  cleanEscapedBraces,
  escapeBraces,
} from "./template";
import { UserForcedPrematureExit } from "./errors";
import CancelTracker from "./canceler";
import { execPy } from "./pyodide/exec-py";
import { baseModelToProvider } from "../ModelSettingSchemas";

// """ =================
//     SETUP AND GLOBALS
//     =================
// """
const DEFAULT_JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

enum MetricType {
  KeyValue = 0,
  KeyValue_Numeric = 1,
  KeyValue_Categorical = 2,
  KeyValue_Mixed = 3,
  Numeric = 4,
  Categorical = 5,
  Mixed = 6,
  Unknown = 7,
  Empty = 8,
}

// """ ==============
//     UTIL FUNCTIONS
//     ==============
// """

// Store the original console log funcs once upon load,
// to ensure we can always revert to them:
const ORIGINAL_CONSOLE_LOG_FUNCS: Dict = console.log
  ? {
      log: console.log,
      warn: console.warn,
      error: console.error,
    }
  : {};
const HIJACKED_CONSOLE_LOGS: Dict = {};

function HIJACK_CONSOLE_LOGGING(id: string, base_window: Dict): void {
  // This function body is adapted from designbyadrian
  // @ GitHub: https://gist.github.com/designbyadrian/2eb329c853516cef618a
  HIJACKED_CONSOLE_LOGS[id] = [];

  if (ORIGINAL_CONSOLE_LOG_FUNCS.log) {
    const cl = ORIGINAL_CONSOLE_LOG_FUNCS.log;
    base_window.console.log = function (...args: any[]) {
      const a = args.map((s) => s.toString());
      HIJACKED_CONSOLE_LOGS[id].push(a.length === 1 ? a[0] : a);
      cl.apply(this, args);
    };
  }

  if (ORIGINAL_CONSOLE_LOG_FUNCS.warn) {
    const cw = ORIGINAL_CONSOLE_LOG_FUNCS.warn;
    base_window.console.warn = function (...args: any[]) {
      const a = args.map((s) => `warn: ${s.toString()}`);
      HIJACKED_CONSOLE_LOGS[id].push(a.length === 1 ? a[0] : a);
      cw.apply(this, args);
    };
  }

  if (ORIGINAL_CONSOLE_LOG_FUNCS.error) {
    const ce = ORIGINAL_CONSOLE_LOG_FUNCS.error;
    base_window.console.error = function (...args: any[]) {
      const a = args.map((s) => `error: ${s.toString()}`);
      HIJACKED_CONSOLE_LOGS[id].push(a.length === 1 ? a[0] : a);
      ce.apply(this, args);
    };
  }
}

function REVERT_CONSOLE_LOGGING(id: string, base_window: Dict): any[] {
  if (ORIGINAL_CONSOLE_LOG_FUNCS.log !== undefined)
    base_window.console.log = ORIGINAL_CONSOLE_LOG_FUNCS.log;
  if (ORIGINAL_CONSOLE_LOG_FUNCS.warn !== undefined)
    base_window.console.warn = ORIGINAL_CONSOLE_LOG_FUNCS.warn;
  if (ORIGINAL_CONSOLE_LOG_FUNCS.log !== undefined)
    base_window.console.error = ORIGINAL_CONSOLE_LOG_FUNCS.error;

  const logs = HIJACKED_CONSOLE_LOGS[id];
  delete HIJACKED_CONSOLE_LOGS[id];
  return logs;
}

/** Stores info about a single LLM response. Passed to evaluator functions. */
export class ResponseInfo {
  text: string; // The text of the LLM response
  prompt: string; // The text of the prompt using to query the LLM
  var: Dict; // A dictionary of arguments that filled in the prompt template used to generate the final prompt
  meta: Dict; // A dictionary of metadata ('metavars') that is 'carried alongside' data used to generate the prompt
  llm: string | LLM; // The name of the LLM queried (the nickname in ChainForge)

  constructor(
    text: string,
    prompt: string,
    _var: Dict,
    meta: Dict,
    llm: string | LLM,
  ) {
    this.text = text;
    this.prompt = prompt;
    this.var = _var;
    this.meta = meta;
    this.llm = llm;
  }

  toString(): string {
    return this.text;
  }

  asMarkdownAST() {
    const md = new MarkdownIt();
    return md.parse(this.text, {});
  }
}

function to_standard_format(r: RawLLMResponseObject | Dict): LLMResponse {
  const resp_obj: LLMResponse = {
    vars: r.vars,
    metavars: r.metavars ?? {},
    llm: r.llm,
    prompt: r.prompt,
    responses: r.responses,
    uid: r.uid ?? uuid(),
  };
  if ("eval_res" in r) resp_obj.eval_res = r.eval_res;
  if ("chat_history" in r) resp_obj.chat_history = r.chat_history;
  return resp_obj;
}

function get_cache_keys_related_to_id(
  cache_id: string,
  include_basefile = true,
): string[] {
  // Load the base cache 'file' for cache_id
  const base_file = `${cache_id}.json`;
  const data = StorageCache.get(base_file);
  if (data?.cache_files !== undefined)
    return Object.keys(data.cache_files).concat(
      include_basefile ? [base_file] : [],
    );
  else return include_basefile ? [base_file] : [];
}
// eslint-disable-next-line
async function setAPIKeys(api_keys: Dict<string>): Promise<void> {
  if (api_keys !== undefined) set_api_keys(api_keys);
}

/**
 * Loads the cache JSON file at filepath.
 * 'Soft fails' if the file does not exist (returns empty object).
 */
function load_from_cache(storageKey: string): Dict {
  return StorageCache.get(storageKey) || {};
}

function load_cache_responses(
  storageKey: string,
): Dict<LLMResponse[]> | LLMResponse[] {
  const data = load_from_cache(storageKey);
  if (Array.isArray(data)) return data;
  else if (typeof data === "object" && data.responses_last_run !== undefined) {
    repairCachedResponses(data, storageKey, (d) => d.responses_last_run);
    return data.responses_last_run;
  }
  throw new Error(`Could not find cache file for id ${storageKey}`);
}

function gen_unique_cache_filename(
  cache_id: string,
  prev_filenames: Array<string>,
): string {
  let idx = 0;
  prev_filenames.forEach((f) => {
    const lhs = f.split(".")[0];
    const num = parseInt(lhs.split("_").pop() as string);
    idx = Math.max(num + 1, idx);
  });
  return `${cache_id}_${idx}.json`;
}

function extract_llm_nickname(llm_spec: StringOrHash | LLMSpec): string {
  if (typeof llm_spec === "object" && llm_spec.name !== undefined)
    return llm_spec.name;
  else
    return (
      StringLookup.get(llm_spec as StringOrHash) ?? "(string lookup failed)"
    );
}

function extract_llm_name(llm_spec: StringOrHash | LLMSpec): string {
  if (typeof llm_spec === "string" || typeof llm_spec === "number")
    return StringLookup.get(llm_spec) ?? "(string lookup failed)";
  else return llm_spec.model;
}

function extract_llm_provider(llm_spec: StringOrHash | LLMSpec): LLMProvider {
  if (typeof llm_spec === "string" || typeof llm_spec === "number")
    return getProvider(StringLookup.get(llm_spec) ?? "") ?? LLMProvider.Custom;
  else return baseModelToProvider(llm_spec.base_model);
}

function extract_llm_key(llm_spec: StringOrHash | LLMSpec): string {
  if (typeof llm_spec === "string" || typeof llm_spec === "number")
    return StringLookup.get(llm_spec) ?? "(string lookup failed)";
  else if (llm_spec.key !== undefined) return llm_spec.key;
  else
    throw new Error(
      `Could not find a key property on spec ${JSON.stringify(
        llm_spec,
      )} for LLM`,
    );
}

function extract_llm_params(llm_spec: StringOrHash | LLMSpec): Dict {
  if (typeof llm_spec === "object" && llm_spec.settings !== undefined)
    return llm_spec.settings;
  else return {};
}

function filterVarsByLLM(vars: PromptVarsDict, llm_key: string): Dict {
  const _vars: PromptVarsDict = {};
  Object.entries(vars).forEach(([key, val]) => {
    const vs = Array.isArray(val) ? val : [val];
    _vars[key] = vs.filter(
      (v) =>
        typeof v === "string" ||
        typeof v === "number" ||
        !("llm" in v) ||
        v.llm === undefined ||
        typeof v.llm === "string" ||
        typeof v.llm === "number" ||
        v.llm.key === llm_key,
    );
  });
  return _vars;
}

/**
 * Test equality akin to Python's list equality.
 */
function isLooselyEqual(value1: any, value2: any): boolean {
  // If both values are non-array types, compare them directly
  if (!Array.isArray(value1) && !Array.isArray(value2)) {
    if (typeof value1 === "object" && typeof value2 === "object")
      return JSON.stringify(value1) === JSON.stringify(value2);
    else return value1 === value2;
  }

  // If either value is not an array or their lengths differ, they are not equal
  if (
    !Array.isArray(value1) ||
    !Array.isArray(value2) ||
    value1.length !== value2.length
  ) {
    return false;
  }

  // Compare each element in the arrays recursively
  for (let i = 0; i < value1.length; i++) {
    if (!isLooselyEqual(value1[i], value2[i])) {
      return false;
    }
  }

  // All elements are equal
  return true;
}

/**
 * Given a cache'd response object, and an LLM name and set of parameters (settings to use),
 * determines whether the response query used the same parameters.
 */
function matching_settings(
  cache_llm_spec: StringOrHash | LLMSpec,
  llm_spec: StringOrHash | LLMSpec,
): boolean {
  if (extract_llm_name(cache_llm_spec) !== extract_llm_name(llm_spec))
    return false;
  if (typeof llm_spec === "object" && typeof cache_llm_spec === "object") {
    const llm_params = extract_llm_params(llm_spec);
    const cache_llm_params = extract_llm_params(cache_llm_spec);
    for (const [param, val] of Object.entries(llm_params)) {
      if (
        param in cache_llm_params &&
        !isLooselyEqual(cache_llm_params[param], val)
      ) {
        return false;
      }
    }
  }
  return true;
}

function areSetsEqual(xs: Set<any>, ys: Set<any>): boolean {
  return xs.size === ys.size && [...xs].every((x) => ys.has(x));
}

function allStringsAreNumeric(strs: Array<string>) {
  return strs.every((s) => !isNaN(parseFloat(s)));
}

function check_typeof_vals(arr: Array<any>): MetricType {
  if (arr.length === 0) return MetricType.Empty;

  const typeof_set: (types: Set<any>) => MetricType = (types: Set<any>) => {
    if (types.size === 0) return MetricType.Empty;
    const [first_val] = types;
    if (
      types.size === 1 &&
      typeof first_val === "object" &&
      !Array.isArray(first_val)
    ) {
      return MetricType.KeyValue;
    } else if (Array.from(types).every((t) => typeof t === "number"))
      // Numeric metrics only
      return MetricType.Numeric;
    else if (
      Array.from(types).every((t) => ["string", "boolean"].includes(typeof t))
    )
      // Categorical metrics only ('bool' is True/False, counts as categorical)
      return MetricType.Categorical;
    else if (
      Array.from(types).every((t) =>
        ["string", "boolean", "number"].includes(typeof t),
      )
    )
      // Mix of numeric and categorical types
      return MetricType.Mixed;
    // Mix of types beyond basic ones
    else return MetricType.Unknown;
  };

  const typeof_dict_vals = (d: Dict) => {
    const dict_val_type = typeof_set(new Set(Object.values(d)));
    if (dict_val_type === MetricType.Numeric)
      return MetricType.KeyValue_Numeric;
    else if (dict_val_type === MetricType.Categorical)
      return MetricType.KeyValue_Categorical;
    else return MetricType.KeyValue_Mixed;
  };

  // Checks type of all values in 'arr' and returns the type
  const val_type = typeof_set(new Set(arr));
  if (val_type === MetricType.KeyValue) {
    // This is a 'KeyValue' pair type. We need to find the more specific type of the values in the dict.
    // First, we check that all dicts have the exact same keys
    for (let i = 0; i < arr.length - 1; i++) {
      const d = arr[i];
      const e = arr[i + 1];
      if (!areSetsEqual(d, e))
        throw new Error(
          "The keys and size of dicts for evaluation results must be consistent across evaluations.",
        );
    }

    // Then, we check the consistency of the type of dict values:
    const first_dict_val_type = typeof_dict_vals(arr[0]);
    arr.slice(1).forEach((d: Dict) => {
      if (first_dict_val_type !== typeof_dict_vals(d))
        throw new Error(
          "Types of values in dicts for evaluation results must be consistent across responses.",
        );
    });

    // If we're here, all checks passed, and we return the more specific KeyValue type:
    return first_dict_val_type;
  } else return val_type;
}

async function run_over_responses(
  process_func: (resp: ResponseInfo) => any,
  responses: LLMResponse[],
  process_type: "evaluator" | "processor",
): Promise<LLMResponse[]> {
  const evald_resps: Promise<LLMResponse>[] = responses.map(
    async (_resp_obj: LLMResponse) => {
      // Deep clone the response object
      const resp_obj: LLMResponse = JSON.parse(JSON.stringify(_resp_obj));

      // Whether the processor function is async or not
      const async_processor =
        process_func?.constructor?.name === "AsyncFunction";

      // Map the processor func over every individual response text in each response object
      const res = resp_obj.responses;
      const llm_name = extract_llm_nickname(resp_obj.llm);
      let processed = res.map((r: LLMResponseData) => {
        const r_info = new ResponseInfo(
          cleanEscapedBraces(llmResponseDataToString(r)),
          StringLookup.get(resp_obj.prompt) ?? "",
          StringLookup.concretizeDict(resp_obj.vars),
          StringLookup.concretizeDict(resp_obj.metavars) || {},
          llm_name,
        );

        // Dynamically detect if process_func is async, and await its response;
        // otherwise, simply execute the function.
        return process_func(r_info);
      });

      // If the processor function is async we still haven't gotten responses; we need to wait for Promises to return:
      // NOTE: For some reason, async_processor check may not work in production builds. To circumvent this,
      //       we also check if 'processed' has a Promise (is it assume all processed items will then be promises).
      if (
        async_processor ||
        (processed.length > 0 && processed[0] instanceof Promise)
      ) {
        processed = await Promise.allSettled(processed);
        for (let i = 0; i < processed.length; i++) {
          const elem = processed[i];
          if (elem.status === "rejected")
            // Bubble up errors
            throw new Error(elem.reason);
          processed[i] = elem.value;
        }
      }

      // If type is just a processor
      if (process_type === "processor") {
        // Replace response texts in resp_obj with the transformed ones:
        resp_obj.responses = processed;
      } else {
        // If type is an evaluator
        // Check the type of evaluation results
        // NOTE: We assume this is consistent across all evaluations, but it may not be.
        const eval_res_type = check_typeof_vals(processed);

        if (eval_res_type === MetricType.Numeric) {
          // Store items with summary of mean, median, etc
          resp_obj.eval_res = {
            items: processed,
            dtype: (getEnumName(MetricType, eval_res_type) ??
              "Unknown") as keyof typeof MetricType,
          };
        } else if (
          [MetricType.Unknown, MetricType.Empty].includes(eval_res_type)
        ) {
          throw new Error(
            "Unsupported types found in evaluation results. Only supported types for metrics are: int, float, bool, str.",
          );
        } else {
          // Categorical, KeyValue, etc, we just store the items:
          resp_obj.eval_res = {
            items: processed,
            dtype: (getEnumName(MetricType, eval_res_type) ??
              "Unknown") as keyof typeof MetricType,
          };
        }
      }

      return resp_obj;
    },
  );

  return await Promise.all(evald_resps);
}

// """ ===================
//     BACKEND FUNCTIONS
//     ===================
// """

/**
 *
 * @param root_prompt The prompt template to start from
 * @param vars a dict of the template variables to fill the prompt template with, by name. (See countQueries docstring for more info).
 * @returns An array of strings representing the prompts that will be sent out. Note that this could include unfilled template vars.
 */
export async function generatePrompts(
  root_prompt: string,
  vars: Dict<PromptVarType[]>,
): Promise<PromptTemplate[]> {
  const gen_prompts = new PromptPermutationGenerator(root_prompt);
  const all_prompt_permutations = Array.from(
    gen_prompts.generate(deepcopy(vars)),
  );
  return all_prompt_permutations;
}

/**
 * Calculates how many queries we need to make, given the passed prompt and vars.
 *
 * @param prompt the prompt template, with any {} vars; or alternatively, an array of such templates
 * @param vars a dict of the template variables to fill the prompt template with, by name.
 *             For each var value, can be single values or a list; in the latter, all permutations are passed. (Pass empty dict if no vars.)
 * @param llms the list of LLMs you will query
 * @param n how many responses expected per prompt
 * @param chat_histories (optional) Either an array of `ChatHistory` (to use across all LLMs), or a dict indexed by LLM nicknames of `ChatHistory` arrays to use per LLM.
 * @param id (optional) a unique ID of the node with cache'd responses. If missing, assumes no cache will be used.
 * @returns If success, a dict with { counts: <dict of missing queries per LLM>, total_num_responses: <dict of total num responses per LLM> }
 *          If there was an error, returns a dict with a single key, 'error'.
 */
export async function countQueries(
  prompt: string | string[],
  vars: PromptVarsDict,
  llms: Array<StringOrHash | LLMSpec>,
  n: number,
  chat_histories?:
    | (ChatHistoryInfo | undefined)[]
    | Dict<(ChatHistoryInfo | undefined)[]>,
  id?: string,
  cont_only_w_prior_llms?: boolean,
): Promise<{ counts: Dict<Dict<number>>; total_num_responses: Dict<number> }> {
  if (chat_histories === undefined) chat_histories = [undefined];
  vars = deepcopy(vars);
  llms = deepcopy(llms);

  const prompt_templates = typeof prompt === "string" ? [prompt] : prompt;
  const all_prompt_permutations: PromptTemplate[] | Dict<PromptTemplate[]> =
    cont_only_w_prior_llms && Array.isArray(llms) ? {} : [];

  for (const pt of prompt_templates) {
    const gen_prompts = new PromptPermutationGenerator(pt);
    if (cont_only_w_prior_llms && Array.isArray(llms)) {
      llms.forEach((llm_spec) => {
        const llm_key = extract_llm_key(llm_spec);
        extendArrayDict(
          all_prompt_permutations as Dict<PromptTemplate[]>,
          llm_key,
          Array.from(gen_prompts.generate(filterVarsByLLM(vars, llm_key))),
        );
      });
    } else {
      extendArray(
        all_prompt_permutations as PromptTemplate[],
        Array.from(gen_prompts.generate(vars)),
      );
    }
  }

  let cache_file_lookup: Dict = {};
  if (id !== undefined) {
    const cache_data = load_from_cache(`${id}.json`);
    cache_file_lookup = cache_data?.cache_files || {};
  }

  const missing_queries: Dict<Dict<number>> = {};
  const num_responses_req: Dict<number> = {};
  const add_to_missing_queries = (
    llm_key: string,
    prompt: string,
    num: number,
  ) => {
    if (!(llm_key in missing_queries)) missing_queries[llm_key] = {};
    if (prompt in missing_queries[llm_key])
      missing_queries[llm_key][prompt] += num;
    else missing_queries[llm_key][prompt] = num;
  };
  const add_to_num_responses_req = (llm_key: string, num: number) => {
    if (!(llm_key in num_responses_req)) num_responses_req[llm_key] = 0;
    num_responses_req[llm_key] += num;
  };

  llms.forEach((llm_spec) => {
    const llm_key = extract_llm_key(llm_spec);

    // Get only the relevant prompt permutations
    const _all_prompt_perms = cont_only_w_prior_llms
      ? (all_prompt_permutations as Dict<PromptTemplate[]>)[llm_key]
      : (all_prompt_permutations as PromptTemplate[]);

    // Get the relevant chat histories for this LLM:
    const chat_hists = (
      !Array.isArray(chat_histories) && chat_histories !== undefined
        ? chat_histories[extract_llm_nickname(llm_spec)]
        : chat_histories
    ) as ChatHistoryInfo[];

    // Find the response cache file for the specific LLM, if any
    let found_cache = false;
    for (const [cache_filename, cache_llm_spec] of Object.entries(
      cache_file_lookup,
    )) {
      if (matching_settings(cache_llm_spec, llm_spec)) {
        found_cache = true;

        // Load the cache file
        const cache_llm_responses: Dict<
          RawLLMResponseObject[] | RawLLMResponseObject
        > = load_from_cache(cache_filename);

        // Iterate through all prompt permutations and check if how many responses there are in the cache with that prompt
        _all_prompt_perms.forEach((prompt) => {
          let prompt_str = prompt.toString();
          const settings_params = extractSettingsVars(prompt.fill_history);
          const media_params = extractMediaVars(prompt.fill_history);

          add_to_num_responses_req(llm_key, n * chat_hists.length);

          // For each chat history, find an indivdual response obj that matches it
          // (chat_hist be undefined, in which case the cache'd response obj must similarly have an undefined chat history in order to match):
          for (const chat_hist of chat_hists) {
            // If there's chat history, we need to fill any special (#) vars from the carried chat_history vars and metavars:
            if (chat_hist !== undefined) {
              prompt.fill_special_vars({
                ...chat_hist?.fill_history,
                ...chat_hist?.metavars,
              });
              prompt_str = prompt.toString();
            }

            // Get the cache of responses with respect to this prompt, + normalize format so it's always an array (of size >= 0)
            const cache_bucket = cache_llm_responses[prompt_str];
            const cached_resps: RawLLMResponseObject[] = Array.isArray(
              cache_bucket,
            )
              ? cache_bucket
              : cache_bucket === undefined
                ? []
                : [cache_bucket];

            let found_resp = false;
            for (const cached_resp of cached_resps) {
              if (
                isEqualChatHistory(
                  cached_resp.chat_history,
                  chat_hist?.messages,
                ) &&
                areEqualVarsDicts(
                  settings_params,
                  extractSettingsVars(cached_resp.vars),
                ) &&
                areEqualVarsDicts(
                  media_params,
                  extractMediaVars(cached_resp.vars),
                )
              ) {
                // Match found. Note it and count response length:
                found_resp = true;
                const num_resps = cached_resp.responses.length;
                if (n > num_resps)
                  add_to_missing_queries(llm_key, prompt_str, n - num_resps);
                break;
              }
            }

            // If a cache'd response wasn't found, add n required:
            if (!found_resp) add_to_missing_queries(llm_key, prompt_str, n);
          }
        });

        break;
      }
    }

    if (!found_cache) {
      _all_prompt_perms.forEach((perm: PromptTemplate) => {
        add_to_num_responses_req(llm_key, n * chat_hists.length);
        add_to_missing_queries(llm_key, perm.toString(), n * chat_hists.length);
      });
    }
  });

  return { counts: missing_queries, total_num_responses: num_responses_req };
}

interface LLMPrompterResults {
  llm_key: string;
  responses: Array<RawLLMResponseObject>;
  errors: Array<string>;
}

export async function fetchEnvironAPIKeys(): Promise<Dict<string>> {
  return fetch(`${FLASK_BASE_URL}app/fetchEnvironAPIKeys`, {
    method: "POST",
    headers: DEFAULT_JSON_HEADERS,
    body: "",
  }).then((res) => res.json());
}

export async function saveFlowToLocalFilesystem(
  flowJSON: Dict,
  filename: string,
  alsoAutosave: boolean,
): Promise<void> {
  try {
    await axios.put(`${FLASK_BASE_URL}api/flows/${filename}`, {
      flow: flowJSON,
      alsoAutosave: alsoAutosave,
    });
  } catch (error) {
    throw new Error(
      `Error saving flow with name ${filename}: ${(error as Error).toString()}`,
    );
  }
}

export async function ensureUniqueFlowFilename(
  filename: string,
): Promise<string> {
  try {
    const response = await axios.put(
      `${FLASK_BASE_URL}api/getUniqueFlowFilename`,
      {
        name: filename,
      },
    );
    return response.data as string;
  } catch (error) {
    console.error(
      `Error contact Flask to ensure unique filename for imported flow. Defaulting to passed filename (warning: risk this overrides an existing flow.) Error: ${(error as Error).toString()}`,
    );
    return filename;
  }
}

/**
 * Queries LLM(s) with root prompt template `prompt` and prompt input variables `vars`, `n` times per prompt.
 * Soft-fails if API calls fail, and collects the errors in `errors` property of the return object.
 * 
 * @param id a unique ID to refer to this information. Used when cache'ing responses. 
 * @param llm a string, list of strings, or list of LLM spec dicts specifying the LLM(s) to query.
 * @param n the amount of generations for each prompt. All LLMs will be queried the same number of times 'n' per each prompt.
 * @param prompt the prompt template, with any {} vars
 * @param vars a dict of the template variables to fill the prompt template with, by name. 
               For each var, can be single values or a list; in the latter, all permutations are passed. (Pass empty dict if no vars.)
 * @param chat_histories Either an array of `ChatHistory` (to use across all LLMs), or a dict indexed by LLM nicknames of `ChatHistory` arrays to use per LLM. 
 * @param api_keys (optional) a dict of {api_name: api_key} pairs. Supported key names: OpenAI, Anthropic, Google
 * @param no_cache (optional) if true, deletes any cache'd responses for 'id' (always calls the LLMs fresh)
 * @param progress_listener (optional) a callback whenever an LLM response is collected, on the current progress
 * @param cont_only_w_prior_llms (optional) whether we are continuing using prior LLMs
 * @param cancel_id (optional) the id that would appear in CancelTracker if the user cancels the querying (NOT the same as 'id' --must be unique!)
 * @returns a dictionary in format `{responses: LLMResponse[], errors: string[]}`
 */
export async function queryLLM(
  id: string,
  llm: string | (string | LLMSpec)[],
  n: number,
  prompt: string,
  vars: PromptVarsDict,
  chat_histories?: ChatHistoryInfo[] | { [key: string]: ChatHistoryInfo[] },
  api_keys?: Dict,
  no_cache?: boolean,
  progress_listener?: (progress: { [key: symbol]: any }) => void,
  cont_only_w_prior_llms?: boolean,
  cancel_id?: string | number,
): Promise<{ responses: LLMResponse[]; errors: Dict<string[]> }> {
  // Verify the integrity of the params
  if (typeof id !== "string" || id.trim().length === 0)
    throw new Error("id is improper format (length 0 or not a string)");

  if (Array.isArray(llm) && llm.length === 0)
    throw new Error(
      "POST data llm is improper format (not string or list, or of length 0).",
    );

  // Ensure llm param is an array
  if (typeof llm === "string") llm = [llm];

  // Cast and deep copy these objects as they may be modified
  llm = deepcopy(llm) as string[] | LLMSpec[];
  vars = deepcopy(vars);

  if (api_keys !== undefined) set_api_keys(api_keys);

  // Get the storage keys of any cache files for specific models + settings
  const llms = llm;
  let cache: Dict = StorageCache.get(`${id}.json`) || {}; // returns {} if 'id' is not in the storage cache yet

  // Ignore cache if no_cache is present
  if (no_cache) cache = {};

  const llm_to_cache_filename: Dict<string> = {};
  const past_cache_files: Dict<string | LLMSpec> = {};
  if (typeof cache === "object" && cache.cache_files !== undefined) {
    const past_cache_files: Dict = cache.cache_files;
    const past_cache_filenames: Array<string> = Object.keys(past_cache_files);
    llms.forEach((llm_spec) => {
      let found_cache = false;
      for (const [filename, cache_llm_spec] of Object.entries(
        past_cache_files,
      )) {
        if (matching_settings(cache_llm_spec, llm_spec)) {
          llm_to_cache_filename[extract_llm_key(llm_spec)] = filename;
          found_cache = true;
          break;
        }
      }
      if (!found_cache) {
        const new_filename = gen_unique_cache_filename(
          id,
          past_cache_filenames,
        );
        llm_to_cache_filename[extract_llm_key(llm_spec)] = new_filename;
        cache.cache_files[new_filename] = llm_spec;
        past_cache_filenames.push(new_filename);
      }
    });
  } else {
    // Create a new cache JSON object
    cache = { cache_files: {}, responses_last_run: [] };
    const prev_filenames: Array<string> = [];
    llms.forEach((llm_spec) => {
      const fname = gen_unique_cache_filename(id, prev_filenames);
      llm_to_cache_filename[extract_llm_key(llm_spec)] = fname;
      cache.cache_files[fname] = llm_spec;
      prev_filenames.push(fname);
    });
  }

  // Store the overall cache file for this id:
  if (!no_cache) StorageCache.store(`${id}.json`, cache);

  // Create a Proxy object to 'listen' for changes to a variable (see https://stackoverflow.com/a/50862441)
  // and then stream those changes back to a provided callback used to update progress bars.
  const progress: { [key: string | symbol]: QueryProgress } = {};
  const progressProxy = new Proxy(progress, {
    set: function (target, key, value) {
      target[key] = value;

      // If the caller provided a callback, notify it
      // of the changes to the 'progress' object:
      if (progress_listener) progress_listener(target);

      return true;
    },
  });

  // Helper function to check whether this process has been canceled
  const should_cancel = () =>
    cancel_id !== undefined && CancelTracker.has(cancel_id);

  // For each LLM, generate and cache responses:
  const responses: { [key: string]: Array<RawLLMResponseObject> } = {};
  const all_errors: Dict<string[]> = {};
  const num_generations = n ?? 1;
  async function query(
    llm_spec: StringOrHash | LLMSpec,
  ): Promise<LLMPrompterResults> {
    // Get LLM model name and any params
    const llm_str = extract_llm_name(llm_spec);
    const llm_provider = extract_llm_provider(llm_spec);
    const llm_nickname = extract_llm_nickname(llm_spec);
    const llm_params = extract_llm_params(llm_spec);
    const llm_key = extract_llm_key(llm_spec);
    const temperature: number =
      llm_params?.temperature !== undefined ? llm_params.temperature : 1.0;
    let _vars = vars;

    if (cont_only_w_prior_llms) {
      // Filter vars so that only the var values with the matching LLM are used, or otherwise values with no LLM metadata
      _vars = filterVarsByLLM(vars, llm_key);
    }

    const chat_hists = (
      chat_histories !== undefined && !Array.isArray(chat_histories)
        ? chat_histories[llm_nickname]
        : chat_histories
    ) as ChatHistoryInfo[];

    // Create an object to query the LLM, passing a storage key for cache'ing responses
    const cache_filepath = llm_to_cache_filename[llm_key];
    const prompter = new PromptPipeline(
      prompt,
      no_cache ? undefined : cache_filepath,
    );

    // Prompt the LLM with all permutations of the input prompt template:
    // NOTE: If the responses are already cache'd, this just loads them (no LLM is queried, saving $$$)
    const resps: Array<RawLLMResponseObject> = [];
    const errors: Array<string> = [];
    let num_resps = 0;
    let num_errors = 0;

    try {
      console.log(`Querying ${llm_str}...`);

      // Yield responses for 'llm' for each prompt generated from the root template 'prompt' and template variables in 'properties':
      for await (const response of prompter.gen_responses(
        _vars,
        llm_str as LLM,
        llm_provider,
        num_generations,
        temperature,
        llm_params,
        chat_hists,
        should_cancel,
      )) {
        // Check for selective failure
        if (response instanceof LLMResponseError) {
          // The request failed
          console.error(
            `error when fetching response from ${llm_str}: ${response.message}`,
          );
          num_errors += 1;
          errors.push(response.message);
        } else {
          // The request succeeded
          // The response name will be the actual name of the LLM. However,
          // for the front-end it is more informative to pass the user-provided nickname.
          response.llm = llm_nickname;
          num_resps += response.responses.length;
          resps.push(response);
        }

        // Update the current 'progress' for this llm.
        // (this implicitly triggers any callbacks defined in the Proxy)
        progressProxy[llm_key] = {
          success: num_resps,
          error: num_errors,
        };
      }
    } catch (e) {
      if (e instanceof UserForcedPrematureExit) {
        throw e;
      } else {
        console.error(
          `Error generating responses for ${llm_str}: ${(e as Error).message}`,
        );
        throw e;
      }
    }

    return {
      llm_key,
      responses: resps,
      errors,
    };
  }

  // Request responses simultaneously across LLMs
  const tasks: Array<Promise<LLMPrompterResults>> = llms.map(query);

  // Await the responses from all queried LLMs
  const llm_results = await Promise.all(tasks);
  llm_results.forEach((result) => {
    responses[result.llm_key] = result.responses;
    if (result.errors.length > 0) all_errors[result.llm_key] = result.errors;
  });

  // Convert the responses into a more standardized format with less information
  const res = Object.values(responses).flatMap((rs) =>
    rs.map(to_standard_format),
  );

  // Reorder the responses to match the original vars dict ordering of keys and values
  const vars_lookup: { [key: string]: Dict<number> } = {}; // we create a lookup table for faster sort
  const getStringForVarObj = (vobj: PromptVarType): string => {
    if (typeof vobj === "string" || typeof vobj === "number") {
      return StringLookup.get(vobj) ?? vobj.toString();
    } else if (typeof vobj === "object" && vobj != null) {
      // If the object has a 'text' property, use that as the key
      if ("text" in vobj && vobj.text !== undefined) {
        return StringLookup.get(vobj.text) ?? vobj.text.toString();
      } else if ("image" in vobj && vobj.image !== undefined) {
        // If the object has an 'image' property, use that as the key
        return vobj.image;
      } else if ("d" in vobj) {
        // Otherwise, use the 'd' property as the key
        return vobj.d;
      } else {
        console.error(`Invalid variable object: ${JSON.stringify(vobj)}`);
      }
    }
    return "(unknown)";
  };
  Object.entries(vars).forEach(([varname, vals]) => {
    vars_lookup[varname] = {};
    if (!Array.isArray(vals)) vals = [vals];
    vals.forEach((vobj, i: number) => {
      vars_lookup[varname][getStringForVarObj(vobj)] = i;
    });
  });
  const vars_entries = Object.entries(vars_lookup);
  res.sort((a, b) => {
    if (!a.vars || !b.vars) return 0;
    for (const [varname, vals] of vars_entries) {
      if (varname in a.vars && varname in b.vars) {
        const a_idx = vals[getStringForVarObj(a.vars[varname])];
        const b_idx = vals[getStringForVarObj(b.vars[varname])];
        if (a_idx > -1 && b_idx > -1 && a_idx !== b_idx) return a_idx - b_idx;
      }
    }
    return 0;
  });

  // Save the responses *of this run* to the storage cache, for further recall:
  const cache_filenames = past_cache_files;
  llms.forEach((llm_spec: string | LLMSpec) => {
    const filename = llm_to_cache_filename[extract_llm_key(llm_spec)];
    cache_filenames[filename] = llm_spec;
  });

  if (!no_cache)
    StorageCache.store(`${id}.json`, {
      cache_files: cache_filenames,
      responses_last_run: res,
    });

  // Return all responses for all LLMs
  return {
    responses: res,
    errors: all_errors,
  };
}
/**
 * A convenience function for a simpler call to queryLLM.
 * This is queryLLM with "no_cache" turned on, no variables, and n=1 responses per prompt.
 * @param prompt The prompt to send off
 * @param llm The LLM(s) to query.
 * @param system_msg Any system message to set on the model (if supported).
 * @param apiKeys Any API keys to use (if needed).
 * @returns
 */
export async function simpleQueryLLM(
  prompt: string,
  llm: string | string[] | LLMSpec[],
  system_msg?: string,
  apiKeys?: Dict,
) {
  const chat_history =
    system_msg === undefined
      ? []
      : [
          {
            messages: [
              {
                role: "system",
                content: system_msg,
              },
            ],
            fill_history: {},
          },
        ];

  return await queryLLM(
    Date.now().toString(), // id to refer to this query
    llm, // llm
    1, // n
    prompt, // prompt
    {}, // vars
    chat_history, // chat_history
    apiKeys, // API keys (if any)
    true, // no_cache mode on
  );
}

/**
 * Executes a Javascript 'evaluate' function over all cache'd responses with given id's.
 *
 * Similar to Flask backend's Python 'execute' function, except requires code to be in Javascript.
 *
 * > **NOTE**: This should only be run on code you trust.
 *             There is no sandboxing; no safety. We assume you are the creator of the code.
 *
 * @param id a unique ID to refer to this information. Used when cache'ing evaluation results.
 * @param code the code to evaluate. Must include an 'evaluate()' function that takes a 'response' of type ResponseInfo. Alternatively, can be the evaluate function itself.
 * @param responses the cache'd response to run on, which must be a unique ID or list of unique IDs of cache'd data
 * @param scope the scope of responses to run on --a single response, or all across each batch. (If batch, evaluate() func has access to 'responses'.) NOTE: Currently this feature is disabled.
 * @param process_type the type of processing to perform. Evaluators only 'score'/annotate responses with an 'eval_res' key. Processors change responses (e.g. text).
 */
export async function executejs(
  id: string,
  code: string | ((rinfo: ResponseInfo) => any),
  responses: LLMResponse[],
  scope: "response" | "batch",
  process_type: "evaluator" | "processor",
): Promise<EvaluatedResponsesResults> {
  const req_func_name =
    !process_type || process_type === "evaluator" ? "evaluate" : "process";

  // Instantiate the evaluator function by eval'ing the passed code
  // DANGER DANGER!!
  let iframe: HTMLElement | null | undefined;
  let process_func: any;
  if (typeof code === "string") {
    try {
      /*
        To run Javascript code in a psuedo-'sandbox' environment, we
        can use an iframe and run eval() inside the iframe, instead of the current environment.
        This is slightly safer than using eval() directly, doesn't clog our namespace, and keeps
        multiple Evaluate node execution environments separate. 
        
        The Evaluate node in the front-end has a hidden iframe with the following id. 
        We need to get this iframe element. 
      */
      iframe = document.getElementById(`${id}-iframe`);
      if (!iframe)
        throw new Error("Could not find iframe sandbox for evaluator node.");

      // Now run eval() on the 'window' of the iframe:
      // @ts-expect-error undefined
      iframe.contentWindow.eval(code);

      // Now check that there is an 'evaluate' method in the iframe's scope.
      // NOTE: We need to tell Typescript to ignore this, since it's a dynamic type check.

      process_func =
        !process_type || process_type === "evaluator"
          ? // @ts-expect-error undefined
            iframe.contentWindow.evaluate
          : // @ts-expect-error undefined
            iframe.contentWindow.process;
      if (process_func === undefined)
        throw new Error(`${req_func_name}() function is undefined.`);
    } catch (err) {
      return {
        error: `Could not compile code. Error message:\n${(err as Error).message}`,
      };
    }
  }

  // Load all responses with the given ID:
  let all_logs: string[] = [];
  let processed_resps: LLMResponse[];
  try {
    // Intercept any calls to console.log, .warn, or .error, so we can store the calls
    // and print them in the 'output' footer of the Evaluator Node:
    // @ts-expect-error undefined
    HIJACK_CONSOLE_LOGGING(id, iframe.contentWindow);

    // Run the user-defined 'evaluate' function over the responses:
    // NOTE: 'evaluate' here was defined dynamically from 'eval' above. We've already checked that it exists.

    processed_resps = await run_over_responses(
      iframe ? process_func : code,
      responses,
      process_type,
    );

    // Revert the console.log, .warn, .error back to browser default:

    all_logs = all_logs.concat(
      // @ts-expect-error undefined
      REVERT_CONSOLE_LOGGING(id, iframe.contentWindow),
    );
  } catch (err) {
    all_logs = all_logs.concat(
      // @ts-expect-error undefined
      REVERT_CONSOLE_LOGGING(id, iframe.contentWindow),
    );
    return {
      error: `Error encountered while trying to run "evaluate" method:\n${(err as Error).message}`,
      logs: all_logs,
    };
  }

  // Store the evaluated responses in a new cache json:
  StorageCache.store(`${id}.json`, processed_resps);

  return { responses: processed_resps, logs: all_logs };
}

/**
 * Executes a Python 'evaluate' function over all cache'd responses with given id's.
 * Requires user to be running on localhost, with Flask access.
 *
 * > **NOTE**: This should only be run on code you trust.
 *             There is no sandboxing; no safety. We assume you are the creator of the code.
 *
 * @param id a unique ID to refer to this information. Used when cache'ing evaluation results.
 * @param code the code to evaluate. Must include an 'evaluate()' function that takes a 'response' of type ResponseInfo. Alternatively, can be the evaluate function itself.
 * @param response_ids the cache'd response to run on, which must be a unique ID or list of unique IDs of cache'd data
 * @param scope the scope of responses to run on --a single response, or all across each batch. (If batch, evaluate() func has access to 'responses'.) NOTE: Currently disabled.
 * @param process_type the type of processing to perform. Evaluators only 'score'/annotate responses with an 'eval_res' key. Processors change responses (e.g. text).
 * @param script_paths paths to custom server-side scripts to import
 * @param executor the way to execute Python code. The option 'flask' runs 'exec' in the backend. The 'pyodide' option spins up a Web Worker with pyodide (running in browser). If the app is not running locally, pyodide is used by default.
 */
export async function executepy(
  id: string,
  code: string | ((rinfo: ResponseInfo) => any),
  responses: LLMResponse[],
  scope: "response" | "batch",
  process_type: "evaluator" | "processor",
  script_paths?: string[],
  executor?: "flask" | "pyodide",
): Promise<EvaluatedResponsesResults> {
  // Determine where we can execute Python
  executor = APP_IS_RUNNING_LOCALLY() ? executor ?? "flask" : "pyodide";

  let exec_response: Dict = {};

  // Execute using Flask backend (unsecure; only use with trusted code)
  if (executor === "flask") {
    // Call our Python server to execute the evaluation code across all responses:
    exec_response = await call_flask_backend("executepy", {
      id,
      code,
      responses,
      scope,
      process_type,
      script_paths,
    }).catch((err) => {
      throw new Error(err.message);
    });

    if (!exec_response || exec_response.error !== undefined)
      throw new Error(
        exec_response?.error || "Empty response received from Flask server",
      );

    // Attempt to execute using Pyodide in a WebWorker (in the browser; safer, sandboxed)
  } else if (executor === "pyodide") {
    const req_func_name =
      !process_type || process_type === "evaluator" ? "evaluate" : "process";
    const all_logs: string[] = [];

    // Create a wrapper to execute the Python code, passing in the ResponseInfo object and outputting the result:
    const code_header = `from collections import namedtuple\nResponseInfo = namedtuple('ResponseInfo', 'text prompt var meta llm')`;
    const eval_func = async (resp: ResponseInfo) => {
      const resp_info_init_code = `__resp_info = ResponseInfo(text=${JSON.stringify(resp.text)}, prompt=${JSON.stringify(resp.prompt)}, var=${JSON.stringify(resp.var)}, meta=${JSON.stringify(resp.meta)}, llm=${JSON.stringify(resp.llm)})`;
      try {
        // We have to pass in resp_info manually, since providing context via "from js import..." results in a race condition
        const { results, error } = await execPy(
          `${code_header}\n${code}\n${resp_info_init_code}\n__out = ${req_func_name}(__resp_info)\n__out`,
        );

        if (results !== undefined) {
          // console.log("pyodideWorker return results: ", results);
          return results;
        } else if (error) {
          all_logs.push(error.toString());
          throw new Error("pyodideWorker error: " + error.toString());
        }
      } catch (err) {
        const e = err as Dict;
        if (e.filename) {
          all_logs.push(e.message());
          throw new Error(
            `Error in pyodideWorker at ${e.filename}, Line: ${e.lineno}, ${e.message}`,
          );
        } else throw e;
      }
    };

    let processed_resps: LLMResponse[];
    try {
      // Run the user-defined 'evaluate' function over the responses:
      processed_resps = await run_over_responses(
        eval_func,
        responses,
        process_type,
      );
    } catch (err) {
      return {
        error: `Error encountered while trying to run "evaluate" method:\n${(err as Error).message}`,
        logs: all_logs,
      };
    }

    exec_response = {
      responses: processed_resps,
      logs: all_logs,
    };
  }

  // Grab the responses and logs from the executor result object:
  const all_evald_responses = exec_response.responses;
  const all_logs = exec_response.logs;

  // Store the evaluated responses in a new cache json:
  StorageCache.store(`${id}.json`, all_evald_responses);

  return { responses: all_evald_responses, logs: all_logs };
}

/**
 * Runs an LLM over responses as a grader/evaluator.
 *
 * @param id a unique ID to refer to this information. Used when cache'ing evaluation results.
 * @param llm the LLM to query (as an LLM specification dict)
 * @param root_prompt the prompt template to use as the scoring function. Should include exactly one template var, {__input}, where input responses will be put.
 * @param response_ids the cache'd response to run on, which must be a unique ID or list of unique IDs of cache'd data
 * @param api_keys optional. any api keys to set before running the LLM
 */
export async function evalWithLLM(
  id: string,
  llm: string | LLMSpec,
  root_prompt: string,
  response_ids: string | string[] | LLMResponse[],
  api_keys?: Dict,
  progress_listener?: (progress: { [key: symbol]: any }) => void,
  cancel_id?: string | number,
  system_msg?: string,
  useReasoning?: boolean,
): Promise<{ responses?: LLMResponse[]; errors: string[] }> {
  // Check format of response_ids
  if (!Array.isArray(response_ids)) response_ids = [response_ids];
  if (response_ids.length === 0) return { responses: [], errors: [] };

  const load_resps_from_cache = typeof response_ids[0] === "string";
  const system_message: ChatHistoryInfo[] | undefined = system_msg
    ? [
        {
          messages: [{ role: "system", content: system_msg }],
          fill_history: {},
        },
      ]
    : undefined;

  if (api_keys !== undefined) set_api_keys(api_keys);

  // Load all responses with the given ID:
  let all_evald_responses: LLMResponse[] = [];
  let all_errors: string[] = [];

  const _runOverResponses = async (
    resp_objs: LLMResponse[],
    cache_id?: string,
  ) => {
    console.log("Running LLM evaluator over response objects:", resp_objs);

    // We need to keep track of the index of each response in the response object.
    // We can generate var dicts with metadata to store the indices:
    const inputs = resp_objs
      .map((obj, __i) =>
        obj.responses.map((r: LLMResponseData, __j: number) => ({
          text:
            typeof r === "string" || typeof r === "number"
              ? escapeBraces(StringLookup.get(r) ?? "(string lookup failed)")
              : undefined,
          image: typeof r === "object" && r.t === "img" ? r.d : undefined,
          fill_history: obj.vars,
          metavars: {
            ...obj.metavars,
            __i: __i.toString(),
            __j: __j.toString(),
          },
        })),
      )
      .flat();

    // Now run all inputs through the LLM grader!:
    const { responses, errors } = await queryLLM(
      `eval-${id}-${cache_id ?? "provided"}`,
      [llm],
      1,
      root_prompt,
      { __input: inputs },
      system_message, // if there's a sys_message, we pass it in chat history format
      undefined,
      undefined,
      progress_listener,
      !cache_id, // if there's no cache_id, we don't want to cache the responses
      cancel_id,
    );

    const err_vals: string[] = Object.values(errors).flat();
    if (err_vals.length > 0) all_errors = all_errors.concat(err_vals);
    // If reasoning mode is enabled, extract the scores from the responses
    if (useReasoning) {
      responses.forEach((r: LLMResponse) => {
        if (!r.responses || r.responses.length === 0) return;

        // Process each response item within the LLMResponse
        r.responses = r.responses.map((response_item) => {
          // First, convert the response item (LLMResponseData) to a string
          const response_str = llmResponseDataToString(response_item);

          // Now apply the regex to the string representation
          if (typeof response_str !== "string") {
            // Should not happen if llmResponseDataToString works correctly, but handle defensively
            console.warn(
              "Response item did not convert to string:",
              response_item,
            );
            return response_item; // Return original item if conversion failed
          }

          // console.log("Attempting to extract score from:", response_str); // Optional: for debugging

          try {
            // Extract the score from the SCORE: format
            const match = response_str.match(
              /score:\s*(\d+(?:\.\d+)?)(?:\s*)?$/i,
            ); // Made decimal part optional
            if (match && match[1]) {
              const extracted_score = match[1].trim();
              // console.log("match found:", extracted_score); // Optional: for debugging
              // Return the extracted score string. This replaces the original
              // response_item (which could be an object) in the r.responses array.
              return extracted_score;
            }
            // If no match, return the original string (or potentially handle as error/default)
            // console.log("No score match found in:", response_str); // Optional: for debugging
            return response_str; // Return the full string if no score pattern found
          } catch (e) {
            console.warn("Failed during regex matching or processing:", e);
            return response_str; // Return the full string in case of error
          }
        });
      });
    }

    // Now we need to apply each response as an eval_res (a score) back to each response object,
    // using the aforementioned mapping metadata:
    responses.forEach((r: LLMResponse) => {
      const __i = parseInt(StringLookup.get(r.metavars.__i as number) ?? "");
      const __j = parseInt(StringLookup.get(r.metavars.__j as number) ?? "");
      // Ensure indices are valid
      if (isNaN(__i) || isNaN(__j) || __i < 0 || __i >= resp_objs.length) {
        console.error(
          `Invalid indices found in response metadata: __i=${__i}, __j=${__j}. Skipping response mapping.`,
        );
        return; // Skip this response
      }
      const resp_obj = resp_objs[__i];
      if (resp_obj.eval_res !== undefined)
        resp_obj.eval_res.items[__j] = llmResponseDataToString(r.responses[0]);
      else {
        resp_obj.eval_res = {
          items: [],
          dtype: "Categorical",
        };
        resp_obj.eval_res.items[__j] = llmResponseDataToString(r.responses[0]);
      }
    });

    return resp_objs;
  };

  // Run over cache'd response data
  if (load_resps_from_cache) {
    for (const cache_id of response_ids) {
      const fname = `${cache_id}.json`;
      if (!StorageCache.has(fname))
        throw new Error(`Did not find cache file for id ${cache_id}`);

      // Load the raw responses from the cache + clone them all:
      const resp_objs = (load_cache_responses(fname) as LLMResponse[]).map(
        (r) => JSON.parse(JSON.stringify(r)),
      ) as LLMResponse[];
      if (resp_objs.length === 0) continue;

      const evald_resp_objs = await _runOverResponses(
        resp_objs,
        cache_id as string,
      );

      all_evald_responses = all_evald_responses.concat(evald_resp_objs);
    }
  } else {
    // Run over provided response objects
    const resp_objs = response_ids as LLMResponse[];
    const evald_resp_objs = await _runOverResponses(resp_objs); // no cache
    all_evald_responses = all_evald_responses.concat(evald_resp_objs);
  }

  // Do additional processing to check if all evaluations are
  // boolean-ish (e.g., 'true' and 'false') or all numeric-ish (parseable as numbers)
  const all_eval_res: Set<string> = new Set();
  for (const resp_obj of all_evald_responses) {
    if (!resp_obj.eval_res) continue;
    for (const score of resp_obj.eval_res.items) {
      if (score !== undefined)
        all_eval_res.add(
          stripWrappingQuotes(score.toString().trim().toLowerCase()),
        );
    }
  }

  // Check if the results are boolean-ish:
  if (
    all_eval_res.size === 2 &&
    (all_eval_res.has("true") ||
      all_eval_res.has("false") ||
      all_eval_res.has("yes") ||
      all_eval_res.has("no"))
  ) {
    // Convert all eval results to boolean datatypes:
    all_evald_responses.forEach((resp_obj) => {
      if (!resp_obj.eval_res?.items) return;
      resp_obj.eval_res.items = resp_obj.eval_res.items.map(
        (i: EvaluationScore) => {
          if (typeof i !== "string") return i;
          const li = i.toLowerCase();
          return li === "true" || li === "yes";
        },
      );
      resp_obj.eval_res.dtype = "Categorical";
    });
    // Check if the results are all numeric-ish:
  } else if (allStringsAreNumeric(Array.from(all_eval_res))) {
    // Convert all eval results to numeric datatypes:
    all_evald_responses.forEach((resp_obj) => {
      if (!resp_obj.eval_res?.items) return;
      resp_obj.eval_res.items = resp_obj.eval_res.items.map(
        (i: EvaluationScore) => {
          if (typeof i !== "string") return i;
          return parseFloat(i);
        },
      );
      resp_obj.eval_res.dtype = "Numeric";
    });
  }

  // Store the evaluated responses in a new cache json:
  if (load_resps_from_cache)
    StorageCache.store(`${id}.json`, all_evald_responses);

  return { responses: all_evald_responses, errors: all_errors };
}

/**
 * Returns all responses with the specified id(s).
 * @param responses the ids to grab
 * @returns If success, a Dict with a single key, 'responses', with an array of LLMResponse objects
 *          If failure, a Dict with a single key, 'error', with the error message.
 */
export async function grabResponses(
  responses: string[],
): Promise<LLMResponse[]> {
  // Grab all responses with the given ID:
  let grabbed_resps: LLMResponse[] = [];
  for (const cache_id of responses) {
    const storageKey = `${cache_id}.json`;
    if (!StorageCache.has(storageKey))
      throw new Error(`Did not find cache data for id ${cache_id}`);

    let res: LLMResponse[] | Dict<LLMResponse[]> =
      load_cache_responses(storageKey);
    if (typeof res === "object" && !Array.isArray(res)) {
      // Convert to standard response format
      res = Object.entries(res).map(([prompt, res_obj]: [string, Dict]) =>
        to_standard_format({ prompt, ...res_obj }),
      );
    }
    grabbed_resps = grabbed_resps.concat(res);
  }

  return grabbed_resps;
}

/**
 * Deletes cache data for the responses indexed by 'id'.
 * @param id The id of the cached responses to clear.
 */
export async function clearCachedResponses(id: string): Promise<boolean> {
  if (!StorageCache.has(`${id}.json`)) {
    console.error(`Did not find cache data for id ${id}`);
    return false;
  }

  // Clear all cache items related to 'id'
  for (const k of get_cache_keys_related_to_id(id, true)) StorageCache.clear(k);

  return true;
}

/**
 * Exports the cache'd data relevant to the given node id(s).
 *
 * @param ids the ids of the nodes to export data for
 * @returns the cache'd data, as a JSON dict in format `{ files: { filename: <Dict|Array> } }`
 */
export async function exportCache(ids: string[]): Promise<Dict<Dict>> {
  // For each id, extract relevant cache file data
  const cache_files: Dict = {};
  for (const cache_id of ids) {
    const cache_keys = get_cache_keys_related_to_id(cache_id);
    if (cache_keys.length === 0) {
      console.warn(
        `Warning: Could not find cache data for id '${cache_id}'. Skipping...`,
      );
      continue;
    }
    cache_keys.forEach((key: string) => {
      cache_files[key] = load_from_cache(key);
    });
  }

  // Bundle up specific other state in StorageCache, which
  // includes things like human ratings for responses:
  const cache_state = StorageCache.getAllMatching(
    (key) => key.startsWith("r.") || key === "__s",
  );

  // Export the MediaLookup table (NOTE: this only contains media file uids and,
  // if running only on the front-end, cache'd media data)
  const mediaCache = await MediaLookup.toJSON();
  cache_state.__media = mediaCache;

  return { ...cache_files, ...cache_state };
}

/**
 * Imports the passed data relevant to specific node id(s), and saves on the backend cache.
 * Used for importing data from an exported flow, so that the flow is self-contained.
 *
 * @param files the name and contents of the cache file
 * @returns Whether the import succeeded or not.
 */
export async function importCache(files: {
  [key: string]: Dict | Array<any>;
}): Promise<void> {
  try {
    // First clear the storage cache and any saved state:
    StorageCache.clear();
    StorageCache.saveToLocalStorage("chainforge-state");

    // Write imported files to StorageCache
    Object.entries(files).forEach(([filename, data]) => {
      if (filename === "__media") {
        // If the cache key is __media, we need to restore the MediaLookup table instead:
        // NOTE: This will NOT override any existing media files in the MediaLookup table.
        MediaLookup.restoreFrom(data as any);
        return;
      }
      StorageCache.store(filename, data);
    });

    // Load StringLookup table from cache
    StringLookup.restoreFrom(StorageCache.get("__s"));
  } catch (err) {
    throw new Error("Error importing from cache:" + (err as Error).message);
  }

  console.log("Imported cache data and stored to cache.");
}

/**
 * Export a flow and its media files as a bundle and download it
 * @param flowData The flow JSON data
 * @param flowName Optional name for the downloaded file
 */
export async function exportFlowBundle(
  flowData: any,
  flowName?: string,
): Promise<void> {
  try {
    // Make a POST request to the export endpoint
    const response = await fetch(`${FLASK_BASE_URL}api/exportFlowBundle`, {
      method: "POST",
      headers: DEFAULT_JSON_HEADERS,
      body: JSON.stringify({
        flow: flowData,
        flowName: flowName || "flow_bundle",
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to export flow bundle: ${response.statusText}`);
    }

    // Get the blob from response (a zip file with .cfzip extension)
    const blob = await response.blob();

    // Create a download link and trigger the download
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.style.display = "none";
    a.href = url;

    // Use the filename from Content-Disposition if available, otherwise use flowName
    const contentDisposition = response.headers.get("Content-Disposition");
    const filenameMatch =
      contentDisposition && contentDisposition.match(/filename="?([^"]+)"?/);
    const filename = filenameMatch
      ? filenameMatch[1]
      : `${flowName || "flow_bundle"}.cfzip`;

    // Download the file
    a.download = filename;
    document.body.appendChild(a);
    a.click();

    // Clean up
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);

    console.log(`Flow bundle exported successfully as ${filename}.`);
  } catch (error) {
    console.error("Error exporting flow bundle:", error);
    throw error;
  }
}

/**
 * Import a flow bundle from a .cfzip file
 * @param file The .cfzip file to import
 * @returns Promise with the imported flow data and name
 */
export async function importFlowBundle(
  file: File,
): Promise<{ flow: any; flowName: string }> {
  if (!file.name.endsWith(".cfzip") && !file.name.endsWith(".zip")) {
    throw new Error("Invalid file format. Expected .cfzip or .zip");
  }

  if (APP_IS_RUNNING_LOCALLY()) {
    // If running locally, use the Flask backend to import the flow bundle
    try {
      // Create form data with the file
      const formData = new FormData();
      formData.append("file", file);

      // Make a POST request to the import endpoint, sending the file over
      // and receiving just the JSON flow data in response
      const response = await fetch(`${FLASK_BASE_URL}api/importFlowBundle`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error ||
            `Failed to import flow bundle: ${response.statusText}`,
        );
      }

      // Parse the response JSON
      const result = await response.json();

      console.log(`Flow bundle imported successfully: ${result.flowName}`);
      return {
        flow: result.flow,
        flowName: result.flowName,
      };
    } catch (error) {
      console.error("Error importing flow bundle:", error);
      throw error;
    }
  } else {
    // Try to unzip and import a flow bundle entirely in the front-end
    const zip = await JSZip.loadAsync(file);

    // Extract flow.json
    const flowFile = zip.file("flow.json");
    if (!flowFile) {
      throw new Error("Missing flow.json in bundle");
    }
    const flowJsonText = await flowFile.async("text");
    const flow = JSON.parse(flowJsonText);

    // Extract media files (if present)
    const mediaFiles = Object.keys(zip.files).filter(
      (path) => path.startsWith("media/") && !zip.files[path].dir,
    );

    // Deliberately clear the media cache before importing
    // NOTE: This will wipe all media cache data, so be careful!
    MediaLookup.clear();

    for (const path of mediaFiles) {
      const fileBlob = await zip.file(path)!.async("blob");
      const filename = path.substring("media/".length); // remove folder prefix
      // Here we manually set the cache data for the media file
      // NOTE: We aren't checking integrity of the media files here, so backend
      // import is preferred if running locally.
      MediaLookup.setCacheData(filename, fileBlob);
    }

    // Here we manually save the state to local storage, just in case
    MediaLookup.getInstance().saveStateToStorageCache();

    const flowName = file.name.replace(/\.(cfzip|zip)$/, "");

    console.log(`Flow bundle imported successfully: ${flowName}`);
    return { flow, flowName };
  }
}

/**
 * Fetches the example flow data, given its filename (without extension).
 * The filename should be the name of a file in the examples/ folder of the package.
 *
 * @param _name The filename (without .cforge extension)
 * @returns a Promise with the JSON of the loaded data
 */
export async function fetchExampleFlow(evalname: string): Promise<Dict> {
  if (APP_IS_RUNNING_LOCALLY()) {
    // Attempt to fetch the example flow from the local filesystem
    // by querying the Flask server:
    return fetch(`${FLASK_BASE_URL}app/fetchExampleFlow`, {
      method: "POST",
      headers: DEFAULT_JSON_HEADERS,
      body: JSON.stringify({ name: evalname }),
    })
      .then(function (res) {
        return res.json();
      })
      .then(function (json) {
        if (json?.error !== undefined || !json?.data)
          throw new Error(
            (json.error as string) ??
              "Request to fetch example flow was sent to backend server, but there was no response.",
          );
        return json.data as Dict;
      });
  }

  // App is not running locally, but hosted on a site.
  // If this is the case, attempt to fetch the example flow from a relative site path:
  return fetch(`examples/${evalname}.cforge`).then((response) =>
    response.json(),
  );
}

/**
 * Fetches a preconverted OpenAI eval as a .cforge JSON file.

   First checks if it's running locally; if so, defaults to Flask backend for this bunction.
   Otherwise, tries to fetch the eval from a relative path on the website. 

 * @param _name The name of the eval to grab (without .cforge extension)
 * @returns a Promise with the JSON of the loaded data
 */
export async function fetchOpenAIEval(evalname: string): Promise<Dict> {
  if (APP_IS_RUNNING_LOCALLY()) {
    // Attempt to fetch the example flow from the local filesystem
    // by querying the Flask server:
    return fetch(`${FLASK_BASE_URL}app/fetchOpenAIEval`, {
      method: "POST",
      headers: DEFAULT_JSON_HEADERS,
      body: JSON.stringify({ name: evalname }),
    })
      .then(function (res) {
        return res.json();
      })
      .then(function (json) {
        if (json?.error !== undefined || !json?.data)
          throw new Error(
            (json.error as string) ??
              "Request to fetch OpenAI eval was sent to backend server, but there was no response.",
          );
        return json.data as Dict;
      });
  }

  // App is not running locally, but hosted on a site.
  // If this is the case, attempt to fetch the example flow from relative path on the site:
  //  > ALT: `https://raw.githubusercontent.com/ianarawjo/ChainForge/main/chainforge/oaievals/${_name}.cforge`
  return fetch(`oaievals/${evalname}.cforge`).then((response) =>
    response.json(),
  );
}

/**
 * Passes a Python script to load a custom model provider to the Flask backend.

 * @param code The Python script to pass, as a string. 
 * @returns a Promise with the JSON of the response. Will include 'error' key if error'd; if success, 
 *          a 'providers' key with a list of all loaded custom provider callbacks, as dicts.
 */
export async function initCustomProvider(
  code: string,
): Promise<CustomLLMProviderSpec[]> {
  // Attempt to fetch the example flow from the local filesystem
  // by querying the Flask server:
  return fetch(`${FLASK_BASE_URL}app/initCustomProvider`, {
    method: "POST",
    headers: DEFAULT_JSON_HEADERS,
    body: JSON.stringify({ code }),
  })
    .then(function (res) {
      return res.json();
    })
    .then(function (json) {
      if (!json || json.error || !json.providers)
        throw new Error(json.error ?? "Unknown error");
      return json.providers as CustomLLMProviderSpec[];
    });
}

/**
 * Asks Python script to remove a custom provider with name 'name'.

 * @param name The name of the provider to remove. The name must match the name in the `ProviderRegistry`.  
 * @returns a Promise with the JSON of the response. Will include 'error' key if error'd; if success, 
 *          a 'success' key with a true value.
 */
export async function removeCustomProvider(name: string): Promise<boolean> {
  // Attempt to fetch the example flow from the local filesystem
  // by querying the Flask server:
  return fetch(`${FLASK_BASE_URL}app/removeCustomProvider`, {
    method: "POST",
    headers: DEFAULT_JSON_HEADERS,
    body: JSON.stringify({ name }),
  })
    .then(function (res) {
      return res.json();
    })
    .then(function (json) {
      if (!json || json.error || !json.success)
        throw new Error(json.error ?? "Unknown error");
      return true;
    });
}

/**
 * Asks Python backend to load custom provider scripts that are cache'd in the user's local dir.
 *
 * @returns a Promise with the JSON of the response. Will include 'error' key if error'd; if success,
 *          a 'providers' key with all loaded custom providers in an array. If there were none, returns empty array.
 */
export async function loadCachedCustomProviders(): Promise<
  CustomLLMProviderSpec[]
> {
  return fetch(`${FLASK_BASE_URL}app/loadCachedCustomProviders`, {
    method: "POST",
    headers: DEFAULT_JSON_HEADERS,
    body: "{}",
  })
    .then(function (res) {
      return res.json();
    })
    .then(function (json) {
      if (!json || json.error || !json.providers)
        throw new Error(
          json.error ??
            "Could not load custom provider scripts: Error contacting backend.",
        );
      return json.providers as CustomLLMProviderSpec[];
    });
}

export async function getGlobalConfig(
  configFilename: string,
): Promise<Dict<JSONCompatible>> {
  return fetch(`${FLASK_BASE_URL}api/getConfig/${configFilename}`, {
    method: "GET",
    headers: DEFAULT_JSON_HEADERS,
  })
    .then(function (res) {
      return res.json();
    })
    .then(function (json) {
      if (typeof json !== "object") {
        console.error(
          `Error loading global ${configFilename}: JSON dict is unexpected return type.`,
        );
        return {};
      }
      return json as Dict<JSONCompatible>;
    })
    .catch((err) => {
      console.error(
        `Failure when trying to load global ${configFilename}: ` +
          err.toString(),
      );
      // Soft fail
      return {};
    });
}

export async function saveGlobalConfig(
  configFilename: string,
  config: Dict<JSONCompatible>,
): Promise<void> {
  fetch(`${FLASK_BASE_URL}api/saveConfig/${configFilename}`, {
    method: "POST",
    headers: DEFAULT_JSON_HEADERS,
    body: JSON.stringify(config),
  })
    .then(function (res) {
      return res.json();
    })
    .then(function (json) {
      if (json.error) {
        console.error(
          `Failure when trying to save global ${configFilename}: ` + json.error,
        );
        // Soft fail
      }
      console.log(`Saved global ${configFilename} to backend successfully.`);
    })
    .catch((err) => {
      console.error(
        `Failure when trying to save global ${configFilename}: ` +
          err.toString(),
      );
      // Soft fail
    });
}

export async function exportToWandB(
  flowData: Dict,
  apiKey: string,
  projectName: string,
): Promise<{ success: boolean; message: string }> {
  try {
    const response = await axios.post(`${FLASK_BASE_URL}api/exportToWandB`, {
      flowData,
      apiKey,
      projectName,
    });
    if (response.data.error) {
      return { success: false, message: response.data.error };
    }
    return {
      success: true,
      message: response.data.message || "Export successful",
    };
  } catch (error) {
    return {
      success: false,
      message: `Error exporting to Weights & Biases: ${(error as Error).message}`,
    };
  }
}
