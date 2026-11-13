export abstract class BaseController {
  protected ok(res: any, body: unknown) {
    res.status(200).json(body);
  }
}
