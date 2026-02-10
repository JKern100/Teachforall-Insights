import { NextResponse } from 'next/server';

export function middleware(request) {
  const password = process.env.APP_PASSWORD;
  
  if (!password) {
    return NextResponse.next();
  }
  
  const authHeader = request.headers.get('authorization');
  
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return new NextResponse('Authentication required', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm=Teach For All Insights'
      }
    });
  }
  
  const base64Credentials = authHeader.split(' ')[1];
  const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
  const [username, userPassword] = credentials.split(':');
  
  if (userPassword !== password) {
    return new NextResponse('Invalid credentials', { status: 401 });
  }
  
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)']
};
