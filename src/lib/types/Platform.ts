import { Route } from './Route';

export class Platform {
  platformNumber: string;
  color: string;
  icon: string | null;
  routes: Route[];
  apiIds: string[];

  constructor({
    platformNumber,
    color = '#FFFFFF',
    icon = null,
    routes = [],
    apiIds = []
  }: {
    platformNumber: string;
    color?: string;
    icon?: string | null;
    routes?: Route[];
    apiIds?: string[];
  }) {
    this.platformNumber = platformNumber;
    this.color = color;
    this.icon = icon;
    this.routes = routes;
    this.apiIds = apiIds;
  }

  addRoute(route: Route) {
    this.routes.push(route);
  }

  displayName() {
    return `Platform ${this.platformNumber}`;
  }
} 