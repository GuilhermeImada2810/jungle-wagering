import { CanActivate, Injectable } from '@nestjs/common';

/**
 * PONTO DE EXTENSAO DE AUTENTICACAO (no-op).
 * Em producao: validar o JWT de um IdP externo (ex.: Keycloak/OIDC) e extrair a
 * identidade do provedor. Os endpoints /health/* devem continuar abertos.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
