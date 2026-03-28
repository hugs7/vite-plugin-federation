const letterReg = new RegExp('[0-9a-zA-Z]+');

export const removeNonRegLetter = (str: string, reg = letterReg): string => {
  let needUpperCase = false;
  let ret = '';

  for (const c of str) {
    if (reg.test(c)) {
      ret += needUpperCase ? c.toUpperCase() : c;
      needUpperCase = false;
    } else {
      needUpperCase = true;
    }
  }
  return ret;
};
