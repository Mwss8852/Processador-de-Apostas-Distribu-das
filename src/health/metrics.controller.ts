import { Controller, Get, Header } from '@nestjs/common';
import { registry } from '@shared/observability/metrics';

@Controller('metrics')
export class MetricsController {
  @Get()
  @Header('Content-Type', 'text/plain')
  async scrape(): Promise<string> {
    return registry.metrics();
  }
}
