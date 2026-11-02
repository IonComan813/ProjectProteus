// 网页版的版本信息。这个文件在 .gitattributes 里标为 export-subst：用 GitHub 的「Code → Download ZIP」
// （或 git archive）下载时，下面的占位符会换成这次提交的编号、日期和最近的标签（git describe --tags）。
// 用 git clone 得到的代码不替换，占位符原样保留，这时页面只显示「网页版」。
// 原生应用（Electron、安卓）有自己的版本号，不用这里的内容。
const SOURCE_INFO = {
  commit: '$Format:%h$',
  date: '$Format:%cs$',
  describe: '$Format:%(describe:tags)$',
};
