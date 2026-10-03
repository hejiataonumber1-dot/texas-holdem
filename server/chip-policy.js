const DEFAULT_INITIAL_CHIPS=2000;
const MAX_INITIAL_CHIPS=1000000;
const INITIAL_CHIPS=DEFAULT_INITIAL_CHIPS;
const LOAN_CHIPS=DEFAULT_INITIAL_CHIPS;

function validateInitialChips(value){
  if(!Number.isSafeInteger(value)||value<1||value>MAX_INITIAL_CHIPS)throw Error('开局筹码须为 1～1,000,000 的整数');
  return value;
}

module.exports={DEFAULT_INITIAL_CHIPS,MAX_INITIAL_CHIPS,INITIAL_CHIPS,LOAN_CHIPS,validateInitialChips};
