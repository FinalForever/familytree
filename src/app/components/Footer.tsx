"use client";


const Footer = ({ familyFullName }: { familyFullName: string }) => {

  return (
    <footer className="bg-white border-t border-gray-200 mt-12">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div>
          {/* 关于族谱 */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold leading-6 text-gray-900">关于族谱</h3>
            <p className="text-sm leading-6 text-gray-600">
              {familyFullName}族谱是一个记录{familyFullName}家族历史和传承的网站，旨在保存家族记忆，传承家族文化。
            </p>
          </div>
        </div>

        {/* 底部版权信息 */}
        <div className="mt-8 border-t border-gray-200 pt-6">
          <p className="text-xs leading-5 text-gray-500 text-center">
            &copy; {new Date().getFullYear()} {familyFullName}家族族谱 · 世代传承
          </p>
        </div>
      </div>
    </footer>
  );
};

export default Footer;