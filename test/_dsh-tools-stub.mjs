// 给 `@deepseek-ai/dsh-tools` 装替身的公共模块。
//
// 为什么要替身：这个包由宿主（Electron asar 内部）在运行时提供，纯 node 里解析不到。
// 装一个替身之后，测试跑的是 lib/ 下的真实代码，而不是另写一份逻辑抄过来 ——
// 抄一份的逻辑永远会通过，因为它测的是抄件，不是真件。
//
// 为什么要抽成文件：host.test.mjs 和 tools.test.mjs 都要装它。复制粘贴的话，
// 哪天 Node 又加/删一个 API，改了这边忘那边，就会变成「一个测试绿、另一个崩」，
// 而且崩的那个还看不出和这个文件有什么关系。
//
// 为什么两条注册路径：`module.registerHooks` 是 Node 22.15 才有的同步钩子，
// Node 20 上它是 undefined —— CI 里 node 20 的 linux/windows 两个 job 都因此挂过
// （`TypeError: module.registerHooks is not a function`）。
// Node 20 有的是 `module.register`（20.6 起），异步加载器写法，resolve 签名一样。
// package.json 声明 engines >=20，测试就必须真的能在 20 上跑起来，否则那个声明是假的。
import module from 'node:module';

const TARGET = '@deepseek-ai/dsh-tools';

// defineTool 的替身：真宿主里它做的是校验参数 schema + 打标记，
// 这里只需要原样透传定义对象，让 tools.js 的 import 保持不变。
const STUB = 'data:text/javascript,' + encodeURIComponent('export const defineTool = (def) => def;');

if (typeof module.registerHooks === 'function') {
  module.registerHooks({
    resolve(specifier, context, next) {
      if (specifier === TARGET) return { url: STUB, shortCircuit: true };
      return next(specifier, context);
    }
  });
} else if (typeof module.register === 'function') {
  module.register(
    'data:text/javascript,' +
      encodeURIComponent(
        `export async function resolve(specifier, context, next) {
           if (specifier === ${JSON.stringify(TARGET)}) return { url: ${JSON.stringify(STUB)}, shortCircuit: true };
           return next(specifier, context);
         }`
      )
  );
} else {
  throw new Error(
    `当前 Node 既没有 module.registerHooks 也没有 module.register，无法为 ${TARGET} 装替身`
  );
}
