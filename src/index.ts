import config from './config';
import service from './service';

function main() {
  service();
  setInterval(service, config.pollPeriodSecond * 1000);
}

main();
